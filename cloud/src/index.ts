// OpenGrid online service (Cloudflare Worker). Routes:
//   POST /v1/account               create an anonymous account -> { id, token }      (max 5 per network per day)
//   GET  /v1/me                    the online career profile
//   GET  /v1/username?u=NAME       is that username free (and valid)?  (no account needed)
//   POST /v1/username { username } claim / change the account's username (unique; a change once per 30 days)
//   GET  /v1/friends               friends (online, party), incoming and outgoing requests
//   POST /v1/friends { username, action: 'add' | 'accept' | 'remove' }   (remove also declines / cancels)
//   POST /v1/presence { party }    heartbeat while the game is open (friends see online + party)
//   POST /v1/buy    { kind, id, stage }   buy a car / upgrade stage / driver gear (level + credits checked here)
//   POST /v1/report { raceId, player, why }
//   POST /v1/replay/:race { data } upload a requested input recording (replay check)
//   GET  /v1/room/:party           WebSocket: the party's race room (Durable Object, room.ts)
//   GET  /v1/replays/pending, POST /v1/replays/:race/:account   replay checker (GitHub Actions; VERIFIER_KEY)
import { CAR_REQ, MOD_REQ, SKIN_REQ, levelOf } from '../../web/src/progression';
import { usernameError } from '../../web/src/username';
import { RaceRoom } from './room';
import { type Env, accountOf, cors, day, json, netOf, profileOf, randomId, sha256, strike, type AccountRow } from './util';

export { RaceRoom };

const MOD_KEYS = ['engine', 'tyres', 'weight', 'aero'] as const;
const RENAME_MS = 30 * 24 * 3600 * 1000;   // one username change per 30 days (the first pick is free)
const ONLINE_MS = 150_000;                 // presence: seen within 2.5 min = online (the game beats every 60 s)
const MAX_FRIENDS = 200;
const byName = (env: Env, u: string) => env.DB.prepare('SELECT * FROM accounts WHERE username = ? COLLATE NOCASE').bind(u).first<AccountRow>();

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), env);
    try { return cors(await route(req, env), env); }
    catch (e) { return cors(json({ error: (e as Error).message || 'server error' }, 500), env); }
  },
};

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url), path = url.pathname;
  if (path === '/' || path === '/v1') return json({ service: 'opengrid', ok: true });

  if (path === '/v1/account' && req.method === 'POST') {
    const net = await netOf(req, env), today = day();
    const row = await env.DB.prepare('SELECT n FROM signups WHERE net = ? AND day = ?').bind(net, today).first<{ n: number }>();
    if ((row?.n ?? 0) >= 5) return json({ error: 'Too many new accounts from this network today.' }, 429);
    const id = randomId(12), token = randomId(32);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO accounts (id, token_hash, name, created, net) VALUES (?, ?, ?, ?, ?)').bind(id, await sha256(token), `Driver ${id.slice(0, 4).toUpperCase()}`, Date.now(), net),
      env.DB.prepare('INSERT INTO signups (net, day, n) VALUES (?, ?, 1) ON CONFLICT (net, day) DO UPDATE SET n = n + 1').bind(net, today),
    ]);
    return json({ id, token });
  }

  // the replay checker (GitHub Actions) authenticates with VERIFIER_KEY
  if (path.startsWith('/v1/replays')) {
    if (!env.VERIFIER_KEY || req.headers.get('authorization') !== `Bearer ${env.VERIFIER_KEY}`) return json({ error: 'forbidden' }, 403);
    if (path === '/v1/replays/pending' && req.method === 'GET') {
      const r = await env.DB.prepare("SELECT race, account, claimed_ms, data FROM replays WHERE status = 'uploaded' LIMIT 20").all();
      return json({ replays: r.results });
    }
    const m = /^\/v1\/replays\/([^/]+)\/([^/]+)$/.exec(path);
    if (m && req.method === 'POST') {
      const { verdict } = await req.json<{ verdict: 'ok' | 'mismatch' | 'unverifiable' }>();
      if (!['ok', 'mismatch', 'unverifiable'].includes(verdict)) return json({ error: 'bad verdict' }, 400);
      await env.DB.prepare('UPDATE replays SET status = ?, data = NULL WHERE race = ? AND account = ?').bind(verdict, m[1], m[2]).run();
      if (verdict === 'mismatch') await strike(env, m[2]);
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  }

  const room = /^\/v1\/room\/([A-Za-z0-9]{4,10})$/.exec(path);
  if (room) {
    if (req.headers.get('upgrade') !== 'websocket') return json({ error: 'websocket expected' }, 426);
    const stub = env.ROOMS.get(env.ROOMS.idFromName(room[1].toUpperCase()));
    return stub.fetch(req);
  }

  if (path === '/v1/username' && req.method === 'GET') {
    const u = (url.searchParams.get('u') ?? '').trim(), err = usernameError(u);
    if (err) return json({ ok: false, error: err });
    return json((await byName(env, u)) ? { ok: false, error: 'That username is taken.' } : { ok: true });
  }

  // everything below: an account
  const acct = await accountOf(req, env);
  if (!acct) return json({ error: 'sign in again (unknown account)' }, 401);

  if (path === '/v1/me' && req.method === 'GET') return json(profileOf(acct));

  if ((path === '/v1/username' || path === '/v1/name') && req.method === 'POST') {
    const b = await req.json<{ username?: string; name?: string }>();
    const u = String(b.username ?? b.name ?? '').trim(), err = usernameError(u);
    if (err) return json({ error: err }, 400);
    if (acct.username === u) return json(profileOf(acct));
    const sameIgnoringCase = acct.username?.toLowerCase() === u.toLowerCase();   // only the capitals change: always allowed
    if (acct.username && !sameIgnoringCase && acct.username_at && Date.now() - acct.username_at < RENAME_MS) {
      const days = Math.ceil((acct.username_at + RENAME_MS - Date.now()) / 86_400_000);
      return json({ error: `You can change your username again in ${days} day${days > 1 ? 's' : ''}.` }, 429);
    }
    const at = sameIgnoringCase ? acct.username_at : Date.now();
    try {
      await env.DB.prepare('UPDATE accounts SET username = ?, name = ?, username_at = ? WHERE id = ?').bind(u, u, at, acct.id).run();
    } catch {   // the unique index: someone else has it (any capitals)
      return json({ error: 'That username is taken.' }, 409);
    }
    return json(profileOf({ ...acct, username: u, name: u, username_at: at }));
  }

  if (path === '/v1/presence' && req.method === 'POST') {
    const b = await req.json<{ party?: string }>().catch(() => ({} as { party?: string }));
    const party = /^[A-Za-z0-9]{4,10}$/.test(String(b.party ?? '')) ? String(b.party).toUpperCase() : null;
    await env.DB.prepare('UPDATE accounts SET seen = ?, party = ? WHERE id = ?').bind(Date.now(), party, acct.id).run();
    return json({ ok: true });
  }

  if (path === '/v1/friends' && req.method === 'GET') {
    const rows = await env.DB.prepare(`SELECT f.state, f.a, f.b, x.username, x.xp, x.seen, x.party FROM friends f JOIN accounts x
      ON x.id = CASE WHEN f.a = ? THEN f.b ELSE f.a END WHERE (f.a = ? OR (f.b = ? AND f.state = 'pending')) AND x.username IS NOT NULL ORDER BY x.username COLLATE NOCASE`)
      .bind(acct.id, acct.id, acct.id).all<{ state: string; a: string; b: string; username: string; xp: number; seen: number | null; party: string | null }>();
    const now = Date.now(), friends = [], incoming = [], outgoing = [];
    for (const r of rows.results) {
      if (r.state === 'friends') {
        const online = !!r.seen && now - r.seen < ONLINE_MS;
        friends.push({ username: r.username, level: levelOf(r.xp).level, online, party: online ? r.party : null });
      } else if (r.a === acct.id) outgoing.push(r.username);
      else incoming.push(r.username);
    }
    return json({ friends, incoming, outgoing });
  }

  if (path === '/v1/friends' && req.method === 'POST') {
    const b = await req.json<{ username?: string; action?: string }>();
    if (!acct.username) return json({ error: 'Pick your username first.' }, 400);
    const other = await byName(env, String(b.username ?? '').trim());
    if (!other) return json({ error: 'No player with that username.' }, 404);
    if (other.id === acct.id) return json({ error: "That's you." }, 400);
    const get = (a: string, c: string) => env.DB.prepare('SELECT state FROM friends WHERE a = ? AND b = ?').bind(a, c).first<{ state: string }>();
    const mine = await get(acct.id, other.id), theirs = await get(other.id, acct.id);
    const both = () => env.DB.batch([
      env.DB.prepare("INSERT INTO friends (a, b, state, created) VALUES (?, ?, 'friends', ?) ON CONFLICT (a, b) DO UPDATE SET state = 'friends'").bind(acct.id, other.id, Date.now()),
      env.DB.prepare("INSERT INTO friends (a, b, state, created) VALUES (?, ?, 'friends', ?) ON CONFLICT (a, b) DO UPDATE SET state = 'friends'").bind(other.id, acct.id, Date.now()),
    ]);
    if (b.action === 'remove') {
      await env.DB.prepare('DELETE FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)').bind(acct.id, other.id, other.id, acct.id).run();
      return json({ ok: true, state: 'none' });
    }
    if (b.action === 'accept') {
      if (theirs?.state !== 'pending') return json({ error: 'No request from that player.' }, 400);
      await both();
      return json({ ok: true, state: 'friends' });
    }
    if (b.action === 'add') {
      if (mine?.state === 'friends') return json({ ok: true, state: 'friends' });
      if (theirs?.state === 'pending') { await both(); return json({ ok: true, state: 'friends' }); }   // they asked first: friends now
      const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM friends WHERE a = ?').bind(acct.id).first<{ n: number }>();
      if ((n?.n ?? 0) >= MAX_FRIENDS) return json({ error: `At most ${MAX_FRIENDS} friends and requests.` }, 400);
      await env.DB.prepare("INSERT OR IGNORE INTO friends (a, b, state, created) VALUES (?, ?, 'pending', ?)").bind(acct.id, other.id, Date.now()).run();
      return json({ ok: true, state: 'pending' });
    }
    return json({ error: 'bad request' }, 400);
  }

  if (path === '/v1/buy' && req.method === 'POST') {
    const b = await req.json<{ kind?: string; id?: string; stage?: number }>();
    const level = levelOf(acct.xp).level;
    const cars: string[] = JSON.parse(acct.cars), skins: string[] = JSON.parse(acct.skins), mods: Record<string, Record<string, number>> = JSON.parse(acct.mods);
    let price = 0;
    if (b.kind === 'car') {
      const r = CAR_REQ[b.id ?? ''];
      if (!r) return json({ error: 'no such car' }, 400);
      if (cars.includes(b.id!) || r.price === 0) return json({ error: 'You already own it.' }, 400);
      if (level < r.mpLevel) return json({ error: `Needs online level ${r.mpLevel}.` }, 403);
      price = r.price; cars.push(b.id!);
    } else if (b.kind === 'skin') {
      const r = SKIN_REQ[b.id ?? ''];
      if (!r) return json({ error: 'no such gear' }, 400);
      if (skins.includes(b.id!) || r.price === 0) return json({ error: 'You already own it.' }, 400);
      if (level < r.mpLevel) return json({ error: `Needs online level ${r.mpLevel}.` }, 403);
      price = r.price; skins.push(b.id!);
    } else if (b.kind === 'mod') {
      const [car, key] = String(b.id ?? '').split(':');
      const stage = Number(b.stage);
      if (!CAR_REQ[car] || !(MOD_KEYS as readonly string[]).includes(key) || !(stage >= 1 && stage <= 3)) return json({ error: 'no such upgrade' }, 400);
      if (car !== 'vela_gt' && !cars.includes(car)) return json({ error: 'Buy the car first.' }, 400);
      const have = mods[car]?.[key] ?? 0;
      if (stage <= have) return json({ error: 'You already own it.' }, 400);
      for (let s = have + 1; s <= stage; s++) {
        const r = MOD_REQ[key as typeof MOD_KEYS[number]][s - 1];
        if (level < r.mpLevel) return json({ error: `Needs online level ${r.mpLevel}.` }, 403);
        price += r.price;
      }
      mods[car] = { engine: 0, tyres: 0, weight: 0, aero: 0, ...(mods[car] ?? {}), [key]: stage };
    } else return json({ error: 'bad request' }, 400);
    // conditional update: two purchases at once can never spend the same credits twice
    const res = await env.DB.prepare('UPDATE accounts SET credits = credits - ?, cars = ?, skins = ?, mods = ? WHERE id = ? AND credits >= ?')
      .bind(price, JSON.stringify(cars), JSON.stringify(skins), JSON.stringify(mods), acct.id, price).run();
    if (!res.meta.changes) return json({ error: 'Not enough credits.' }, 402);
    const fresh = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(acct.id).first<AccountRow>();
    return json(profileOf(fresh!));
  }

  if (path === '/v1/report' && req.method === 'POST') {
    const b = await req.json<{ raceId?: string; player?: string; why?: string }>();
    if (!b.raceId || !b.player) return json({ error: 'bad request' }, 400);
    await env.DB.prepare('INSERT INTO reports (race, reporter, player, why, created) VALUES (?, ?, ?, ?, ?)')
      .bind(String(b.raceId).slice(0, 40), acct.id, String(b.player).slice(0, 40), String(b.why ?? '').slice(0, 200), Date.now()).run();
    return json({ ok: true });
  }

  const rp = /^\/v1\/replay\/([^/]+)$/.exec(path);
  if (rp && req.method === 'POST') {
    const { data } = await req.json<{ data?: string }>();
    if (typeof data !== 'string' || data.length > 900_000) return json({ error: 'bad recording' }, 400);
    const res = await env.DB.prepare("UPDATE replays SET data = ?, status = 'uploaded' WHERE race = ? AND account = ? AND status = 'requested'").bind(data, rp[1], acct.id).run();
    return json(res.meta.changes ? { ok: true } : { error: 'no replay was requested' }, res.meta.changes ? 200 : 404);
  }

  return json({ error: 'not found' }, 404);
}

