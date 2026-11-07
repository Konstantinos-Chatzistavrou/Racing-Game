// Matchmaking smoke test: starts server.js on a spare port, checks /health and that the PeerJS endpoint hands
// out ids (GET /peerjs/<key>/id). The full party flow over WebRTC is web/tools/party_test.mjs. Run: npm test
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const srv = spawn(process.execPath, [fileURLToPath(new URL('./server.js', import.meta.url))], {
  env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((res, rej) => {
  srv.stdout.on('data', (d) => d.toString().includes('listening') && res());
  srv.on('exit', (c) => rej(new Error(`server exited ${c}`)));
});
try {
  const h = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
  assert.equal(h.ok, true); console.log('  ok  /health');
  const id = await (await fetch(`http://127.0.0.1:${PORT}/peerjs/peerjs/id`)).text();
  assert.match(id, /^[0-9a-f-]{20,}$/); console.log('  ok  PeerJS hands out ids:', id);
} finally { srv.kill(); }
