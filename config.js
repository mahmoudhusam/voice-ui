import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = {
  whisperServerPath: path.resolve(__dirname, '..', 'whisper.cpp-master', 'build', 'bin', 'whisper-server'),
  modelPath: path.resolve(__dirname, '..', 'whisper.cpp-master', 'models', 'ggml-medium-q5_0.bin'),
  ffmpegPath: '/usr/bin/ffmpeg',
  uploadDir: path.resolve(__dirname, 'uploads'),
  outputDir: path.resolve(__dirname, 'outputs'),
  port: 3000,
  whisperServerHost: '127.0.0.1',
  whisperServerPort: 8178,
  useGpu: false,
};

// Auto-create directories if they don't exist
fs.mkdirSync(config.uploadDir, { recursive: true });
fs.mkdirSync(config.outputDir, { recursive: true });

export default config;
