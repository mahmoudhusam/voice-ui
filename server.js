import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import config from './config.js';
import transcribeRouter from './routes/transcribe.js';
import { startServer as startWhisperServer, stopServer as stopWhisperServer } from './services/whisper-server-manager.js';

const app = express();
const server = http.createServer(app);

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Routes
app.use('/api', transcribeRouter);

// WebSocket setup
const wss = new WebSocketServer({ server });
const clients = new Map();
let shutdownTimer = null;

wss.on('connection', (ws) => {
  const clientId = uuidv4();

  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
    console.log('[Server] Shutdown cancelled - client reconnected');
  }

  clients.set(clientId, ws);

  console.log(`[WS] Client connected: ${clientId}`);

  ws.send(JSON.stringify({ type: 'connected', id: clientId }));

  ws.on('close', () => {
    clients.delete(clientId);
    console.log(`[WS] Client disconnected: ${clientId}`);

    if (clients.size === 0) {
      console.log('[Server] No clients connected. Shutting down in 5 seconds...');
      shutdownTimer = setTimeout(async () => {
        console.log('[Server] Shutting down...');
        await stopWhisperServer();
        process.exit(0);
      }, 5000);
    }
  });
});

export function broadcastToClient(clientId, data) {
  const ws = clients.get(clientId);
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// Startup
try {
  await startWhisperServer(config);
  server.listen(config.port, () => {
    console.log(`[Server] Running at http://localhost:${config.port}`);
  });
} catch (err) {
  console.error('[Server] Failed to start whisper-server:', err.message);
  process.exit(1);
}

process.on('SIGINT', async () => {
  await stopWhisperServer();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await stopWhisperServer();
  process.exit(0);
});
