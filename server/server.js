import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import { spawn } from 'child_process';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Mutex } from 'async-mutex';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/api/v1/stream-vitals' });

app.use(express.json());
app.use(express.static(join(__dirname, '../client/dist')));

const PYTHON_SCRIPT = join(__dirname, 'python', 'rppg_processor.py');
const SESSION_TIMEOUT_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 5000;
const MAX_PENDING_CHUNKS = 5;
const RESTART_DELAY_MS = 500;

const sessions = new Map();

class PythonWorker {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.process = null;
    this.stdoutBuffer = '';
    this.mutex = new Mutex();
    this.pendingChunks = 0;
    this.lastActivity = Date.now();
    this.restarting = false;
    this.spawn();
  }

  spawn() {
    if (this.restarting) return;
   const PYTHON_BIN = process.platform === 'win32'
  ? join(__dirname, 'python', 'venv', 'Scripts', 'python.exe')
  : 'python3';
this.process = spawn(PYTHON_BIN, ['-u', PYTHON_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    this.process.stdout.on('data', (data) => this.handleStdout(data));
    this.process.stderr.on('data', (data) => console.error(`[Python ${this.sessionId}] STDERR:`, data.toString()));
    this.process.on('exit', (code, signal) => this.handleExit(code, signal));
    this.process.on('error', (err) => console.error(`[Python ${this.sessionId}] Spawn error:`, err));
  }

  handleStdout(data) {
    this.stdoutBuffer += data.toString();
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const result = JSON.parse(line);
        this.onResult?.(result);
      } catch (e) {
        console.error(`[Python ${this.sessionId}] JSON parse error:`, line);
      }
    }
  }

  handleExit(code, signal) {
    console.warn(`[Python ${this.sessionId}] Exited: code=${code}, signal=${signal}`);
    if (!this.restarting) {
      this.restarting = true;
      setTimeout(() => {
        this.restarting = false;
        this.spawn();
        if (this.lastWindow) this.write(this.lastWindow);
        if (this.prevWindow) this.write(this.prevWindow);
      }, RESTART_DELAY_MS);
    }
  }

  write(windowData) {
    if (!this.process || this.process.killed) return false;
    if (this.pendingChunks >= MAX_PENDING_CHUNKS) return false;

    this.pendingChunks++;
    this.lastWindow = windowData;
    const payload = JSON.stringify(windowData) + '\n';
    this.process.stdin.write(payload, (err) => {
      this.pendingChunks = Math.max(0, this.pendingChunks - 1);
      if (err) console.error(`[Python ${this.sessionId}] stdin write error:`, err);
    });
    return true;
  }

  setResultHandler(handler) {
    this.onResult = handler;
  }

  kill() {
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');
    }
  }
}

function createSession(sessionId) {
  const worker = new PythonWorker(sessionId);
  const mutex = new Mutex();

  worker.setResultHandler((result) => {
    const session = sessions.get(sessionId);
    if (session && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify(result));
    }
  });

  const session = {
    id: sessionId,
    worker,
    mutex,
    ws: null,
    lastActivity: Date.now(),
    buffer: [],
  };

  sessions.set(sessionId, session);
  return session;
}

function cleanupSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    session.worker.kill();
    sessions.delete(sessionId);
    console.log(`Session ${sessionId} cleaned up`);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      console.log(`Session ${id} timed out`);
      cleanupSession(id);
    }
  }
}, 10000);

wss.on('connection', (ws, req) => {
  const sessionId = req.url.split('sessionId=')[1] || `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  console.log(`New connection: ${sessionId}`);

  let session = sessions.get(sessionId);
  if (!session) {
    session = createSession(sessionId);
  }
  session.ws = ws;
  session.lastActivity = Date.now();

  ws.on('message', async (data) => {
    session.lastActivity = Date.now();
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      if (msg.window) {
        const release = await session.mutex.acquire();
        try {
          const ok = session.worker.write({ sessionId, window: msg.window});
          if (!ok) {
            console.warn(`Backpressure: ${sessionId} queue full`);
          }
        } finally {
          release();
        }
      }
    } catch (e) {
      console.error(`Message parse error:`, e);
    }
  });

  ws.on('close', () => {
    console.log(`WS closed: ${sessionId}`);
    setTimeout(() => {
      const s = sessions.get(sessionId);
      if (s && s.ws?.readyState === WebSocket.CLOSED) {
        cleanupSession(sessionId);
      }
    }, 10000);
  });

  ws.on('error', (err) => {
    console.error(`WS error ${sessionId}:`, err);
  });

  ws.send(JSON.stringify({ type: 'connected', sessionId }));
});

app.get('/health', (req, res) => res.json({ status: 'ok', sessions: sessions.size }));

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`PranaFlow-AI server running on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/api/v1/stream-vitals`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  for (const [id] of sessions) cleanupSession(id);
  server.close(() => process.exit(0));
});