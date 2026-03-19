import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import http from 'http';
import config from '../config.js';
import { isReady } from './whisper-server-manager.js';

const WHISPER_TIMEOUT = 30 * 60 * 1000; // 30 minutes

export async function processFile(job, progressCallback) {
  const wavPath = path.join(config.uploadDir, `${job.id}.wav`);

  try {
    // Step A: Convert to WAV
    await convertToWav(job.filePath, wavPath, job.id, progressCallback);

    // Step B: Transcribe via whisper-server
    const outputFiles = await runWhisper(wavPath, job, progressCallback);

    // Step C: Cleanup temp files
    cleanup(job.filePath, wavPath);

    return outputFiles;
  } catch (err) {
    cleanup(job.filePath, wavPath);
    throw err;
  }
}

function convertToWav(inputPath, outputPath, jobId, progressCallback) {
  return new Promise((resolve, reject) => {
    console.log(`[Whisper] Converting to WAV: ${inputPath}`);

    let ffmpegProcess;
    try {
      ffmpegProcess = spawn(config.ffmpegPath, [
        '-i', inputPath,
        '-ar', '16000',
        '-ac', '1',
        '-c:a', 'pcm_s16le',
        '-y',
        outputPath,
      ]);
    } catch (err) {
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}. Is ffmpeg installed at ${config.ffmpegPath}?`));
      return;
    }

    let totalDuration = null;
    let stderrOutput = '';

    ffmpegProcess.stderr.on('data', (data) => {
      const text = data.toString();
      stderrOutput += text;

      if (!totalDuration) {
        const durationMatch = text.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
        if (durationMatch) {
          const hours = parseInt(durationMatch[1]);
          const minutes = parseInt(durationMatch[2]);
          const seconds = parseInt(durationMatch[3]);
          totalDuration = hours * 3600 + minutes * 60 + seconds;
        }
      }

      const timeMatch = text.match(/time=(\d+):(\d+):(\d+)\.(\d+)/);
      if (timeMatch && totalDuration > 0) {
        const hours = parseInt(timeMatch[1]);
        const minutes = parseInt(timeMatch[2]);
        const seconds = parseInt(timeMatch[3]);
        const currentTime = hours * 3600 + minutes * 60 + seconds;
        const percent = Math.min(100, Math.round((currentTime / totalDuration) * 100));
        progressCallback({ stage: 'converting', percent });
      }
    });

    ffmpegProcess.on('error', (err) => {
      reject(new Error(`Failed to start ffmpeg: ${err.message}. Is ffmpeg installed at ${config.ffmpegPath}?`));
    });

    ffmpegProcess.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderrOutput.slice(-500)}`));
      } else {
        console.log(`[Whisper] WAV conversion complete`);
        progressCallback({ stage: 'converting', percent: 100 });
        resolve();
      }
    });
  });
}

async function runWhisper(wavPath, job, progressCallback) {
  console.log(`[Whisper] Sending to whisper-server for job ${job.id}`);

  if (!isReady()) {
    throw new Error('Whisper server is not running. Please restart the application.');
  }

  progressCallback({ stage: 'transcribing', percent: 0 });

  // Read WAV file and send to whisper-server for verbose_json
  const wavBuffer = fs.readFileSync(wavPath);
  const result = await sendToWhisperServer(wavBuffer, job.language, job.task);


  console.log(`[Whisper] Transcription complete for job ${job.id}`);
  progressCallback({ stage: 'transcribing', percent: 100 });

  // Generate output files from verbose_json
  const outputPrefix = path.join(config.outputDir, job.id);
  const outputFiles = [];
  const segments = result.segments || [];

  const formatGenerators = {
    txt: { ext: '.txt', generate: () => generateTxt(segments) },
    srt: { ext: '.srt', generate: () => generateSrt(segments) },
    vtt: { ext: '.vtt', generate: () => generateVtt(segments) },
    json: { ext: '.json', fileSuffix: '', generate: () => JSON.stringify(result, null, 2) },
    lrc: { ext: '.lrc', generate: () => generateLrc(segments) },
    csv: { ext: '.csv', generate: () => generateCsv(segments) },
    'json-full': { ext: '.json', fileSuffix: '_full', generate: () => JSON.stringify(result, null, 2) },
  };

  for (const fmt of job.outputFormats) {
    const gen = formatGenerators[fmt];
    if (!gen) continue;

    const suffix = gen.fileSuffix || '';
    const filePath = outputPrefix + suffix + gen.ext;
    const content = gen.generate();
    fs.writeFileSync(filePath, content, 'utf-8');

    outputFiles.push({
      filename: `${job.id}${suffix}${gen.ext}`,
      format: fmt,
      path: filePath,
    });
  }

  // Copy files to custom output path if specified
  if (job.outputPath) {
    try {
      if (!fs.existsSync(job.outputPath)) {
        fs.mkdirSync(job.outputPath, { recursive: true });
      }
      const baseName = job.outputBaseName || path.parse(job.originalName).name;
      const ts = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const timestamp = `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())}_${pad(ts.getHours())}-${pad(ts.getMinutes())}-${pad(ts.getSeconds())}`;
      for (const o of outputFiles) {
        const extMap = { 'json-full': 'json', lrc: 'lrc', csv: 'csv' };
        const ext = extMap[o.format] || o.format;
        const sfx = o.format === 'json-full' ? '_full' : '';
        const destName = `${baseName}_${timestamp}${sfx}.${ext}`;
        const destPath = path.join(job.outputPath, destName);
        fs.copyFileSync(o.path, destPath);
        o.savedPath = destPath;
      }
    } catch (err) {
      console.error(`[Whisper] Failed to save to output path: ${err.message}`);
    }
  }

  if (outputFiles.length === 0) {
    throw new Error('Whisper completed but no output files could be generated');
  }

  return outputFiles;
}

// --- HTTP request to whisper-server (raw http to avoid fetch timeout) ---

function sendToWhisperServer(wavBuffer, language, task) {
  return new Promise((resolve, reject) => {
    const boundary = '----WhisperBoundary' + Date.now();
    const CRLF = '\r\n';

    // Build multipart body
    const parts = [];

    // file field
    parts.push(`--${boundary}${CRLF}`);
    parts.push(`Content-Disposition: form-data; name="file"; filename="audio.wav"${CRLF}`);
    parts.push(`Content-Type: audio/wav${CRLF}${CRLF}`);
    const fileHeader = Buffer.from(parts.join(''));
    const fileFooter = Buffer.from(CRLF);

    // text fields
    const fields = { response_format: 'verbose_json', language, temperature: '0.0' };
    if (task === 'translate') {
      fields.translate = 'true';
    }
    const fieldBuffers = [];
    for (const [key, value] of Object.entries(fields)) {
      fieldBuffers.push(Buffer.from(
        `--${boundary}${CRLF}Content-Disposition: form-data; name="${key}"${CRLF}${CRLF}${value}${CRLF}`
      ));
    }

    const closing = Buffer.from(`--${boundary}--${CRLF}`);
    const body = Buffer.concat([fileHeader, wavBuffer, fileFooter, ...fieldBuffers, closing]);

    const options = {
      hostname: config.whisperServerHost,
      port: config.whisperServerPort,
      path: '/inference',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      timeout: WHISPER_TIMEOUT,
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const responseText = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode !== 200) {
          reject(new Error(`Whisper server returned ${res.statusCode}: ${responseText.slice(0, 500)}`));
          return;
        }
        try {
          resolve(JSON.parse(responseText));
        } catch {
          reject(new Error(`Whisper server returned invalid JSON: ${responseText.slice(0, 200)}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Whisper processing timed out after 30 minutes'));
    });

    req.on('error', (err) => {
      reject(new Error(`Failed to connect to whisper-server: ${err.message}`));
    });

    req.write(body);
    req.end();
  });
}

// --- Format generators ---

function generateTxt(segments) {
  return segments.map((s) => s.text.trim()).join('\n');
}

function generateSrt(segments) {
  return segments.map((s, i) => {
    const start = formatTimestamp(s.t0 != null ? s.t0 / 1000 : s.start, true);
    const end = formatTimestamp(s.t1 != null ? s.t1 / 1000 : s.end, true);
    return `${i + 1}\n${start} --> ${end}\n${s.text.trim()}\n`;
  }).join('\n');
}

function generateVtt(segments) {
  const lines = ['WEBVTT', ''];
  for (const s of segments) {
    const start = formatTimestamp(s.t0 != null ? s.t0 / 1000 : s.start, false);
    const end = formatTimestamp(s.t1 != null ? s.t1 / 1000 : s.end, false);
    lines.push(`${start} --> ${end}`);
    lines.push(s.text.trim());
    lines.push('');
  }
  return lines.join('\n');
}

function generateLrc(segments) {
  return segments.map((s) => {
    const seconds = s.t0 != null ? s.t0 / 1000 : s.start;
    const sec = seconds == null || isNaN(seconds) ? 0 : seconds;
    const m = Math.floor(sec / 60);
    const secs = sec % 60;
    const mm = String(m).padStart(2, '0');
    const ssxx = secs.toFixed(2).padStart(5, '0');
    return `[${mm}:${ssxx}] ${s.text.trim()}`;
  }).join('\n');
}

function generateCsv(segments) {
  const lines = ['start,end,text'];
  for (const s of segments) {
    const start = Math.round((s.t0 != null ? s.t0 : (s.start || 0) * 1000));
    const end = Math.round((s.t1 != null ? s.t1 : (s.end || 0) * 1000));
    const text = '"' + s.text.trim().replace(/"/g, '""') + '"';
    lines.push(`${start},${end},${text}`);
  }
  return lines.join('\n');
}

function formatTimestamp(seconds, srtFormat) {
  if (seconds == null || isNaN(seconds)) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  const sep = srtFormat ? ',' : '.';
  return (
    String(h).padStart(2, '0') + ':' +
    String(m).padStart(2, '0') + ':' +
    String(s).padStart(2, '0') + sep +
    String(ms).padStart(3, '0')
  );
}

// --- Cleanup ---

function cleanup(originalFile, wavFile) {
  try {
    if (fs.existsSync(originalFile)) fs.unlinkSync(originalFile);
  } catch (err) {
    console.error(`[Whisper] Failed to delete original file: ${err.message}`);
  }
  try {
    if (fs.existsSync(wavFile)) fs.unlinkSync(wavFile);
  } catch (err) {
    console.error(`[Whisper] Failed to delete WAV file: ${err.message}`);
  }
}
