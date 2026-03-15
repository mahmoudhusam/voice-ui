import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = {
  whisperPath: path.resolve(__dirname, '..', 'whisper.cpp-master', 'build', 'bin', 'whisper-cli'),
  modelPath: path.resolve(__dirname, '..', 'whisper.cpp-master', 'models', 'ggml-large-v3-q5_0.bin'),
  ffmpegPath: '/usr/bin/ffmpeg',
  uploadDir: path.resolve(__dirname, 'uploads'),
  outputDir: path.resolve(__dirname, 'outputs'),
  port: 3000,
};

// Auto-create directories if they don't exist
fs.mkdirSync(config.uploadDir, { recursive: true });
fs.mkdirSync(config.outputDir, { recursive: true });

export default config;
