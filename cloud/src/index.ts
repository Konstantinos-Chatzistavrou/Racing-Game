// OpenGrid online service (Cloudflare Worker). Routes:
//   POST /v1/account               create an anonymous account -> { id, token }      (max 5 per network per day)
//   GET  /v1/me                    the online career profile
//   POST /v1/name   { name }       display name
//   POST /v1/buy    { kind, id, stage }   buy a car / upgrade stage / driver gear (level + credits checked here)
//   POST /v1/report { raceId, player, why }
//   POST /v1/replay/:race { data } upload a requested input recording (replay check)
//   GET  /v1/room/:party           WebSocket: the party's race room (Durable Object, room.ts)
//   GET  /v1/replays/pending, POST /v1/replays/:race/:account   replay checker (GitHub Actions; VERIFIER_KEY)
import { CAR_REQ, MOD_REQ, SKIN_REQ, levelOf } from '../../web/src/progression';
import { RaceRoom } from './room';
import { type Env, accountOf, cors, day, json, netOf, profileOf, randomId, sha256, strike, type AccountRow } from './util';

export { RaceRoom };

const MOD_KEYS = ['engine', 'tyres', 'weight', 'aero'] as const;

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

  // everything below: an account
  const acct = await accountOf(req, env);
  if (!acct) return json({ error: 'sign in again (unknown account)' }, 401);

  if (path === '/v1/me' && req.method === 'GET') return json(profileOf(acct));

  if (path === '/v1/name' && req.method === 'POST') {
    const { name } = await req.json<{ name?: string }>();
    const clean = String(name ?? '').replace(/[<>&"'`]/g, '').trim().slice(0, 18) || acct.name;
    await env.DB.prepare('UPDATE accounts SET name = ? WHERE id = ?').bind(clean, acct.id).run();
    return json(profileOf({ ...acct, name: clean }));
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

