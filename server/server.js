// Night Run multiplayer relay: every client sends its car pose, the server forwards it to everyone
// else. No physics or authority here: it only keeps each player's last pose so newcomers see the
// others at once. Run: npm start (PORT env, default 8787). Health check: GET /health.
import http from 'node:http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT) || 8787;
const MAX_MESSAGE = 512;        // bytes: a pose is ~120
const RATE = 30;                // messages per second per client (token bucket)
const BURST = 45;
const MAX_PLAYERS = 64;
const MAX_COORD = 1e5;          // metres: anything beyond is garbage
const KEYS = ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw'];

const app = express();
app.disable('x-powered-by');
app.get('/health', (_req, res) => res.json({ ok: true, players: players.size, uptime: Math.round(process.uptime()) }));
app.get('/', (_req, res) => res.type('text').send('Night Run multiplayer relay. Connect over WebSocket.'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE });

/** id -> { ws, state, tokens, last } */
const players = new Map();
let nextId = 1;

const send = (ws, msg) => { if (ws.readyState === WebSocket.OPEN) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); };
const broadcast = (msg, exceptId) => {
  const data = JSON.stringify(msg);
  for (const [id, p] of players) if (id !== exceptId) send(p.ws, data);
};

/** Returns a clean pose or null. Quaternion is renormalised (rejected if degenerate). */
function parseState(m) {
  const s = {};
  for (const k of KEYS) {
    const v = m[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    s[k] = v;
  }
  if (Math.abs(s.x) > MAX_COORD || Math.abs(s.y) > MAX_COORD || Math.abs(s.z) > MAX_COORD) return null;
  const n = Math.hypot(s.qx, s.qy, s.qz, s.qw);
  if (n < 0.5 || n > 1.5) return null;
  s.qx /= n; s.qy /= n; s.qz /= n; s.qw /= n;
  if (Number.isInteger(m.c) && m.c >= 0 && m.c <= 0xffffff) s.c = m.c;   // paint colour, optional
  return s;
}

wss.on('connection', (ws) => {
  if (players.size >= MAX_PLAYERS) { ws.close(1013, 'server full'); return; }
  const id = nextId++;
  const p = { ws, state: null, tokens: BURST, last: Date.now() };
  players.set(id, p);
  const others = [];
  for (const [oid, o] of players) if (oid !== id && o.state) others.push({ id: oid, ...o.state });
  send(ws, { type: 'welcome', id, players: others });
  broadcast({ type: 'join', id }, id);
  console.log(`+ player ${id} (${players.size} online)`);

  ws.on('message', (data, isBinary) => {
    // token bucket: refill RATE/s, drop (not disconnect) when empty
    const now = Date.now();
    p.tokens = Math.min(BURST, p.tokens + (now - p.last) * RATE / 1000);
    p.last = now;
    if (p.tokens < 1) return;
    p.tokens -= 1;
    if (isBinary || data.length > MAX_MESSAGE) return;
    let m;
    try { m = JSON.parse(data.toString('utf8')); } catch { return; }
    if (!m || typeof m !== 'object' || m.type !== 'state') return;
    const s = parseState(m);
    if (!s) return;
    p.state = s;
    broadcast({ type: 'state', id, ...s }, id);
  });

  ws.on('close', () => {
    players.delete(id);
    broadcast({ type: 'leave', id });
    console.log(`- player ${id} (${players.size} online)`);
  });
  ws.on('error', () => ws.terminate());
});

// Drop dead connections (laptop lid closed, network gone) so they don't linger as frozen cars.
const ping = setInterval(() => {
  for (const { ws } of players.values()) {
    if (ws.alive === false) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 10000);
wss.on('connection', (ws) => { ws.alive = true; ws.on('pong', () => (ws.alive = true)); });
wss.on('close', () => clearInterval(ping));

server.listen(PORT, () => console.log(`relay listening on :${PORT}`));
