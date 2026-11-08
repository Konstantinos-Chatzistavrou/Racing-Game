// Helpers shared by the API and the race room.
export interface Env {
  DB: D1Database;
  ROOMS: DurableObjectNamespace;
  /** secret salt for network hashes (wrangler secret put IP_SALT) */
  IP_SALT?: string;
  /** replay checker key (wrangler secret put VERIFIER_KEY) */
  VERIFIER_KEY?: string;
  ALLOWED_ORIGINS?: string;
  /** local tests only (.dev.vars): honour the x-test-ip header to simulate players on different networks */
  ALLOW_TEST_IP?: string;
}

export interface AccountRow {
  id: string; token_hash: string; name: string; created: number; xp: number; credits: number;
  cars: string; mods: string; skins: string; clean: number; strikes: number; banned: number; net: string | null;
  username: string | null; username_at: number | null; seen: number | null; party: string | null;
}

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function cors(r: Response, env: Env) {
  if (r.status === 101) return r;   // WebSocket upgrade: headers are immutable
  const h = new Headers(r.headers);
  h.set('access-control-allow-origin', env.ALLOWED_ORIGINS === '*' || !env.ALLOWED_ORIGINS ? '*' : env.ALLOWED_ORIGINS.split(',')[0]);
  h.set('access-control-allow-headers', 'content-type, authorization');
  h.set('access-control-allow-methods', 'GET, POST, OPTIONS');
  return new Response(r.body, { status: r.status, headers: h });
}

export async function sha256(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomId(n: number) {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789', b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => a[x % a.length]).join('');
}

/** UTC day, for daily caps */
export const day = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

/**
 * The player's network as a salted hash: an IPv4 address, or the /64 prefix of an IPv6 address (one household or one
 * phone line). The raw address is never stored.
 */
export async function netOf(req: Request, env: Env) {
  let ip = req.headers.get('cf-connecting-ip') ?? '0.0.0.0';
  if (env.ALLOW_TEST_IP === '1' && req.headers.get('x-test-ip')) ip = req.headers.get('x-test-ip')!;
  if (env.ALLOW_TEST_IP === '1' && new URL(req.url).searchParams.get('testip')) ip = new URL(req.url).searchParams.get('testip')!;
  const key = ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip;
  return (await sha256(`${env.IP_SALT ?? 'dev-salt'}|${key}`)).slice(0, 24);
}

/** The account from "Authorization: Bearer <id>.<token>" (or ?auth= on WebSockets, which cannot send headers). */
export async function accountOf(req: Request, env: Env): Promise<AccountRow | null> {
  const raw = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '') || new URL(req.url).searchParams.get('auth') || '';
  const [id, token] = raw.split('.');
  if (!id || !token || id.length > 40 || token.length > 200) return null;
  const row = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first<AccountRow>();
  if (!row || row.token_hash !== (await sha256(token))) return null;
  return row;
}

export const profileOf = (a: AccountRow) => ({
  id: a.id, name: a.username ?? a.name, username: a.username, usernameAt: a.username_at, xp: a.xp, credits: a.credits,
  cars: JSON.parse(a.cars) as string[], mods: JSON.parse(a.mods), skins: JSON.parse(a.skins) as string[],
  clean: a.clean, strikes: a.strikes, banned: !!a.banned, created: a.created,
});

/** A confirmed cheat: a strike; three bar the account from ranked races. */
export async function strike(env: Env, account: string) {
  await env.DB.prepare('UPDATE accounts SET strikes = strikes + 1, banned = CASE WHEN strikes + 1 >= 3 THEN 1 ELSE banned END WHERE id = ?').bind(account).run();
}
