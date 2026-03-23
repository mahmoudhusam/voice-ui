import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import config from '../config.js';
import { addJob, getJob } from '../services/queue.js';

const router = Router();

const storage = multer.diskStorage({
  destination: config.uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({ storage });

// Full list of languages supported by whisper.cpp
const SUPPORTED_LANGUAGES = new Set([
  'auto',
  'af', 'am', 'ar', 'as', 'az',
  'ba', 'be', 'bg', 'bn', 'bo', 'br', 'bs',
  'ca', 'cs', 'cy',
  'da', 'de',
  'el', 'en', 'es', 'et', 'eu',
  'fa', 'fi', 'fo', 'fr',
  'gl', 'gu',
  'ha', 'haw', 'he', 'hi', 'hr', 'ht', 'hu', 'hy',
  'id', 'is', 'it',
  'ja', 'jw',
  'ka', 'kk', 'km', 'kn', 'ko',
  'la', 'lb', 'ln', 'lo', 'lt', 'lv',
  'mg', 'mi', 'mk', 'ml', 'mn', 'mr', 'ms', 'mt', 'my',
  'ne', 'nl', 'nn', 'no',
  'oc',
  'pa', 'pl', 'ps', 'pt',
  'ro', 'ru',
  'sa', 'sd', 'si', 'sk', 'sl', 'sn', 'so', 'sq', 'sr', 'su', 'sv', 'sw',
  'ta', 'te', 'tg', 'th', 'tk', 'tl', 'tr', 'tt',
  'uk', 'ur', 'uz',
  'vi',
  'yi', 'yo',
  'zh', 'zu',
  // Also accept full language names
  'afrikaans', 'amharic', 'arabic', 'assamese', 'azerbaijani',
  'bashkir', 'belarusian', 'bulgarian', 'bengali', 'tibetan', 'breton', 'bosnian',
  'catalan', 'czech', 'welsh',
  'danish', 'german',
  'greek', 'english', 'spanish', 'estonian', 'basque',
  'persian', 'finnish', 'faroese', 'french',
  'galician', 'gujarati',
  'hausa', 'hawaiian', 'hebrew', 'hindi', 'croatian', 'haitian creole', 'hungarian', 'armenian',
  'indonesian', 'icelandic', 'italian',
  'japanese', 'javanese',
  'georgian', 'kazakh', 'khmer', 'kannada', 'korean',
  'latin', 'luxembourgish', 'lingala', 'lao', 'lithuanian', 'latvian',
  'malagasy', 'maori', 'macedonian', 'malayalam', 'mongolian', 'marathi', 'malay', 'maltese', 'myanmar',
  'nepali', 'dutch', 'nynorsk', 'norwegian',
  'occitan',
  'punjabi', 'polish', 'pashto', 'portuguese',
  'romanian', 'russian',
  'sanskrit', 'sindhi', 'sinhala', 'slovak', 'slovenian', 'shona', 'somali', 'albanian', 'serbian', 'sundanese', 'swedish', 'swahili',
  'tamil', 'telugu', 'tajik', 'thai', 'turkmen', 'tagalog', 'turkish', 'tatar',
  'ukrainian', 'urdu', 'uzbek',
  'vietnamese',
  'yiddish', 'yoruba',
  'chinese', 'zulu',
]);

const SUPPORTED_FORMATS = new Set(['txt', 'srt', 'vtt', 'json', 'lrc', 'csv', 'json-full']);

// POST /api/transcribe
router.post('/transcribe', upload.array('files', 10), (req, res) => {
  try {
    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const { language, clientId, outputBaseName, outputPath } = req.body;
    let { outputFormats } = req.body;
    const task = req.body.task || 'transcribe';

    if (!language) {
      return res.status(400).json({ error: 'Language is required' });
    }

    if (!SUPPORTED_LANGUAGES.has(language.toLowerCase())) {
      return res.status(400).json({ error: `Unsupported language: ${language}` });
    }

    if (task !== 'transcribe' && task !== 'translate') {
      return res.status(400).json({ error: `Invalid task: ${task}. Must be 'transcribe' or 'translate'` });
    }

    // outputFormats may come as a JSON string or as repeated form fields
    if (typeof outputFormats === 'string') {
      try {
        outputFormats = JSON.parse(outputFormats);
      } catch {
        outputFormats = [outputFormats];
      }
    }

    if (!Array.isArray(outputFormats) || outputFormats.length === 0) {
      return res.status(400).json({ error: 'outputFormats must be a non-empty array' });
    }

    for (const fmt of outputFormats) {
      if (!SUPPORTED_FORMATS.has(fmt)) {
        return res.status(400).json({ error: `Unsupported output format: ${fmt}` });
      }
    }

    const jobResponses = [];

    for (const file of files) {
      const job = {
        id: uuidv4(),
        originalName: file.originalname,
        filePath: file.path,
        language: language.toLowerCase(),
        outputFormats,
        clientId,
        outputBaseName: outputBaseName || '',
        task,
        outputPath: outputPath || '',
        status: 'queued',
      };

      addJob(job);
      jobResponses.push({ id: job.id, originalName: job.originalName, status: job.status });
    }

    console.log(`[API] ${files.length} file(s) queued for transcription`);
    res.json({ success: true, jobs: jobResponses });
  } catch (err) {
    console.error('[API] Error handling upload:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/jobs/:jobId/outputs
router.get('/jobs/:jobId/outputs', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (job.status !== 'completed') {
    return res.status(400).json({ error: `Job is not completed. Current status: ${job.status}` });
  }

  const outputs = job.outputs.map((o) => ({
    filename: o.filename,
    format: o.format,
    downloadUrl: `/api/jobs/${job.id}/download/${o.filename}`,
  }));

  res.json({ jobId: job.id, outputs });
});

// GET /api/jobs/:jobId/download/:filename
router.get('/jobs/:jobId/download/:filename', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (job.status !== 'completed') {
    return res.status(400).json({ error: 'Job is not completed yet' });
  }

  const output = job.outputs.find((o) => o.filename === req.params.filename);
  if (!output) {
    return res.status(404).json({ error: 'File not found' });
  }

  const baseName = job.outputBaseName || path.parse(job.originalName).name;
  const ts = job.completedAt ? new Date(job.completedAt) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timestamp = `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())}_${pad(ts.getHours())}-${pad(ts.getMinutes())}-${pad(ts.getSeconds())}`;
  const extMap = { 'json-full': 'json', lrc: 'lrc', csv: 'csv' };
  const ext = extMap[output.format] || output.format;
  const suffix = output.format === 'json-full' ? '_full' : '';
  const downloadName = `${baseName}_${timestamp}${suffix}.${ext}`;

  res.download(output.path, downloadName);
});

// GET /api/jobs/:jobId/preview
router.get('/jobs/:jobId/preview', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (job.status !== 'completed') {
    return res.status(400).json({ error: 'Job is not completed yet' });
  }

  // Look for txt output first
  const txtOutput = job.outputs.find((o) => o.format === 'txt');
  if (txtOutput) {
    try {
      const text = fs.readFileSync(txtOutput.path, 'utf-8');
      return res.json({ text });
    } catch {
      return res.json({ text: 'Failed to read output file.' });
    }
  }

  // Fallback: try json output
  const jsonOutput = job.outputs.find((o) => o.format === 'json');
  if (jsonOutput) {
    try {
      const data = JSON.parse(fs.readFileSync(jsonOutput.path, 'utf-8'));
      const text = (data.segments || []).map((s) => s.text.trim()).join('\n');
      return res.json({ text: text || 'No text content found.' });
    } catch {
      return res.json({ text: 'Failed to read output file.' });
    }
  }

  res.json({ text: 'No text output available. Please include Text (.txt) in your output formats.' });
});

// GET /api/browse-folders
router.get('/browse-folders', (req, res) => {
  try {
    let targetPath = req.query.path ? String(req.query.path) : '';

    // If no path provided, use home directory
    if (!targetPath) {
      targetPath = os.homedir();
    }

    // On Windows, if no path was provided, also include drive letters
    const isWindows = os.platform() === 'win32';
    let drives = [];
    if (isWindows && !req.query.path) {
      for (let i = 65; i <= 90; i++) {
        const letter = String.fromCharCode(i);
        const drivePath = letter + ':\\';
        try {
          if (fs.existsSync(drivePath)) {
            drives.push(drivePath);
          }
        } catch {
          // skip inaccessible drives
        }
      }
    }

    // Resolve to absolute path
    targetPath = path.resolve(targetPath);

    if (!fs.existsSync(targetPath)) {
      return res.status(400).json({ error: 'Path does not exist' });
    }

    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }

    let entries;
    try {
      entries = fs.readdirSync(targetPath, { withFileTypes: true });
    } catch (err) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    const folders = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    const parentPath = path.dirname(targetPath);

    res.json({
      currentPath: targetPath,
      parentPath: parentPath !== targetPath ? parentPath : null,
      folders,
      drives: drives.length > 0 ? drives : undefined,
    });
  } catch (err) {
    console.error('[API] Error browsing folders:', err);
    res.status(500).json({ error: 'Failed to browse folders' });
  }
});

export default router;
