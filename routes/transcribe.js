import { Router } from 'express';
import multer from 'multer';
import path from 'path';
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

const SUPPORTED_FORMATS = new Set(['txt', 'srt', 'vtt', 'json']);

// POST /api/transcribe
router.post('/transcribe', upload.array('files', 10), (req, res) => {
  try {
    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const { language, clientId } = req.body;
    let { outputFormats } = req.body;

    if (!language) {
      return res.status(400).json({ error: 'Language is required' });
    }

    if (!SUPPORTED_LANGUAGES.has(language.toLowerCase())) {
      return res.status(400).json({ error: `Unsupported language: ${language}` });
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

  res.download(output.path, `${path.parse(job.originalName).name}.${output.format}`);
});

export default router;
