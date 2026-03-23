import { spawn } from 'child_process';

let serverProcess = null;
let ready = false;
let progressCallback = null;

export function onProgress(callback) { progressCallback = callback; }
export function offProgress() { progressCallback = null; }

export async function startServer(config) {
  const args = [
    '--model', config.modelPath,
    '--host', config.whisperServerHost,
    '--port', String(config.whisperServerPort),
    '--print-progress',
  ];

  if (!config.useGpu) {
    args.push('--no-gpu');
  }

  console.log(`[WhisperServer] Starting: ${config.whisperServerPath}`);
  console.log(`[WhisperServer] Model: ${config.modelPath}`);
  console.log(`[WhisperServer] GPU: ${config.useGpu ? 'enabled' : 'disabled'}`);

  serverProcess = spawn(config.whisperServerPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', (data) => {
    const text = data.toString().trim();
    if (text) console.log(`[WhisperServer] ${text}`);
  });

  serverProcess.stderr.on('data', (data) => {
    const text = data.toString().trim();
    if (text) console.log(`[WhisperServer] ${text}`);

    const progressMatch = text.match(/progress\s*=\s*(\d+)%/);
    if (progressMatch && progressCallback) {
      const percent = parseInt(progressMatch[1]);
      progressCallback(percent);
    }
  });

  serverProcess.on('error', (err) => {
    ready = false;
    console.error(`[WhisperServer] Failed to start: ${err.message}`);
  });

  serverProcess.on('exit', (code) => {
    ready = false;
    if (code !== null && code !== 0) {
      console.error(`[WhisperServer] Exited with code ${code}`);
    }
    serverProcess = null;
  });

  // Wait for health check
  const url = `http://${config.whisperServerHost}:${config.whisperServerPort}`;
  const maxAttempts = 60; // 30 seconds at 500ms intervals
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(500);
    if (!serverProcess) {
      throw new Error('whisper-server process exited before becoming ready');
    }
    try {
      const res = await fetch(`${url}/inference`, { method: 'GET' });
      // Server is listening if we get any response (even 4xx)
      ready = true;
      console.log(`[WhisperServer] Ready on port ${config.whisperServerPort}`);
      return;
    } catch {
      // Not ready yet
    }
  }
  throw new Error(`whisper-server failed to start within 30 seconds`);
}

export async function stopServer() {
  if (!serverProcess) return;

  console.log('[WhisperServer] Stopping...');
  ready = false;

  serverProcess.kill('SIGTERM');

  // Wait up to 5 seconds for graceful shutdown
  const killed = await Promise.race([
    new Promise((resolve) => {
      serverProcess.once('exit', () => resolve(true));
    }),
    sleep(5000).then(() => false),
  ]);

  if (!killed && serverProcess) {
    console.log('[WhisperServer] Force killing...');
    serverProcess.kill('SIGKILL');
  }

  serverProcess = null;
  console.log('[WhisperServer] Stopped');
}

export function isReady() {
  return ready && serverProcess !== null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
