import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import config from '../config.js';

const WHISPER_TIMEOUT = 30 * 60 * 1000; // 30 minutes

export async function processFile(job, progressCallback) {
  const wavPath = path.join(config.uploadDir, `${job.id}.wav`);

  try {
    // Step A: Convert to WAV
    await convertToWav(job.filePath, wavPath, job.id, progressCallback);

    // Step B: Run whisper-cli
    const outputFiles = await runWhisper(wavPath, job, progressCallback);

    // Step C: Cleanup temp files
    cleanup(job.filePath, wavPath);

    return outputFiles;
  } catch (err) {
    // Cleanup on error too
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

      // Parse total duration from ffmpeg output: "Duration: HH:MM:SS.ms"
      if (!totalDuration) {
        const durationMatch = text.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
        if (durationMatch) {
          const hours = parseInt(durationMatch[1]);
          const minutes = parseInt(durationMatch[2]);
          const seconds = parseInt(durationMatch[3]);
          totalDuration = hours * 3600 + minutes * 60 + seconds;
        }
      }

      // Parse progress: "time=HH:MM:SS.ms"
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

function runWhisper(wavPath, job, progressCallback) {
  return new Promise((resolve, reject) => {
    console.log(`[Whisper] Running whisper-cli for job ${job.id}`);

    const outputPrefix = path.join(config.outputDir, job.id);

    const args = [
      '-m', config.modelPath,
      '-f', wavPath,
      '--language', job.language,
      '--no-gpu',
      '-pp',
    ];

    // Add output format flags
    const formatFlags = { txt: '-otxt', srt: '-osrt', vtt: '-ovtt', json: '-oj' };
    for (const fmt of job.outputFormats) {
      if (formatFlags[fmt]) {
        args.push(formatFlags[fmt]);
      }
    }

    args.push('-of', outputPrefix);

    let whisperProcess;
    try {
      whisperProcess = spawn(config.whisperPath, args);
    } catch (err) {
      reject(new Error(`Failed to spawn whisper-cli: ${err.message}. Is whisper-cli at ${config.whisperPath}?`));
      return;
    }

    let stderrOutput = '';

    const timeout = setTimeout(() => {
      console.error(`[Whisper] Job ${job.id} timed out after 30 minutes`);
      whisperProcess.kill('SIGKILL');
      reject(new Error('Whisper processing timed out after 30 minutes'));
    }, WHISPER_TIMEOUT);

    const parseProgress = (text) => {
      // whisper_full_with_state: progress = XX%
      const match = text.match(/progress\s*=\s*(\d+)%/);
      if (match) {
        const percent = parseInt(match[1]);
        progressCallback({ stage: 'transcribing', percent });
      }
    };

    whisperProcess.stdout.on('data', (data) => {
      parseProgress(data.toString());
    });

    whisperProcess.stderr.on('data', (data) => {
      const text = data.toString();
      stderrOutput += text;
      parseProgress(text);
    });

    whisperProcess.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start whisper-cli: ${err.message}. Is whisper-cli at ${config.whisperPath}?`));
    });

    whisperProcess.on('close', (code) => {
      clearTimeout(timeout);

      if (code !== 0) {
        reject(new Error(`whisper-cli exited with code ${code}: ${stderrOutput.slice(-500)}`));
        return;
      }

      console.log(`[Whisper] Transcription complete for job ${job.id}`);
      progressCallback({ stage: 'transcribing', percent: 100 });

      // Find output files matching the job ID
      const outputFiles = [];
      const formatExtensions = { txt: '.txt', srt: '.srt', vtt: '.vtt', json: '.json' };

      for (const fmt of job.outputFormats) {
        const ext = formatExtensions[fmt];
        const filePath = outputPrefix + ext;
        if (fs.existsSync(filePath)) {
          outputFiles.push({
            filename: `${job.id}${ext}`,
            format: fmt,
            path: filePath,
          });
        }
      }

      if (outputFiles.length === 0) {
        reject(new Error('Whisper completed but no output files were found'));
        return;
      }

      resolve(outputFiles);
    });
  });
}

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
