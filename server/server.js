// OpenGrid matchmaking (optional): a self-hosted PeerJS server. The game's parties (web/src/party.ts) are
// peer to peer over WebRTC; a PeerJS server only introduces the players. By default the game uses the free
// public one (0.peerjs.com), so you only need this if that is down or you want your own:
//   npm start            (PORT env, default 9000)
//   open the game with   ?peer=your-host:9000/peerjs   (wss:// / https:// prefix for TLS)
// Health check: GET /health.
import http from 'node:http';
import express from 'express';
import { ExpressPeerServer } from 'peer';

const PORT = Number(process.env.PORT) || 9000;
const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);
let peers = 0;
const peer = ExpressPeerServer(server, { path: '/', allow_discovery: false, proxied: !!process.env.PROXIED });
peer.on('connection', () => peers++);
peer.on('disconnect', () => peers--);
app.use('/peerjs', peer);
app.get('/health', (_req, res) => res.json({ ok: true, peers, uptime: Math.round(process.uptime()) }));
app.get('/', (_req, res) => res.type('text').send('OpenGrid matchmaking (PeerJS). Point the game at it with ?peer=<host>:<port>/peerjs'));
server.listen(PORT, () => console.log(`matchmaking listening on :${PORT} (PeerJS at /peerjs)`));
