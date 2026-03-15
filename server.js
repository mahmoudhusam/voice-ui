import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import config from './config.js';
import transcribeRouter from './routes/transcribe.js';

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

wss.on('connection', (ws) => {
  const clientId = uuidv4();
  clients.set(clientId, ws);

  console.log(`[WS] Client connected: ${clientId}`);

  ws.send(JSON.stringify({ type: 'connected', id: clientId }));

  ws.on('close', () => {
    clients.delete(clientId);
    console.log(`[WS] Client disconnected: ${clientId}`);
  });
});

export function broadcastToClient(clientId, data) {
  const ws = clients.get(clientId);
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

server.listen(config.port, () => {
  console.log(`[Server] Running at http://localhost:${config.port}`);
});
