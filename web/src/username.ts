// Usernames: one per player, unique (case-insensitive) on the online service, the name friends add and everyone sees in
// races (leaderboard, name tags, number plates). Shared by the game and the server (cloud/src/index.ts), like progression.ts.
//
// Rules: 3-16 characters, letters A-Z / a-z, digits, and _ . - (not first, not twice in a row). '#' is never allowed: names
// starting with '#' belong to the computer drivers (#Bot1, #Bot2 ...), so nobody can pass for one and no bot for a player.

export const USERNAME_MIN = 3, USERNAME_MAX = 16;
const ALLOWED = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** whole names (case-insensitive) nobody may take: impersonation of the game / staff, and words the UI uses */
const RESERVED = new Set(['admin', 'administrator', 'mod', 'moderator', 'staff', 'support', 'system', 'server', 'opengrid', 'official',
  'you', 'me', 'driver', 'player', 'guest', 'anonymous', 'null', 'undefined', 'leader', 'dnf', 'host', 'everyone']);

/** null if `s` is a valid username, otherwise why not (shown under the input as is). */
export function usernameError(s: string): string | null {
  if (s.includes('#')) return '# is reserved for the computer drivers.';
  if (/\s/.test(s)) return 'No spaces.';
  if (s.length < USERNAME_MIN) return `At least ${USERNAME_MIN} characters.`;
  if (s.length > USERNAME_MAX) return `At most ${USERNAME_MAX} characters.`;
  if (!ALLOWED.test(s)) return /^[_.-]/.test(s) ? 'Start with a letter or a digit.' : 'Letters, digits and _ . - only.';
  if (/[_.-]{2}/.test(s)) return 'No two of _ . - in a row.';
  const low = s.toLowerCase();
  if (RESERVED.has(low) || /^bot\d*$/.test(low)) return 'That name is reserved.';
  return null;
}

/** The computer drivers of single player races: #Bot1, #Bot2 ... (no player can have a '#'). */
export const botName = (i: number) => `#Bot${i + 1}`;
export const isBotName = (s: string) => s.startsWith('#');

/** Plate characters of a US-style plate. */
export const PLATE_MAX = 8;
/** The name as it goes on a number plate, or null when it does not fit (the car keeps a registration of its own). */
export function plateText(name: string): string | null {
  const t = name.trim().toUpperCase();
  return t.length > 0 && t.length <= PLATE_MAX ? t : null;
}
/** A registration for a car whose name does not fit: 3 letters, a space, 4 digits, from a hash of the name (stable). */
export function registration(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  const L = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < 3; i++) { s += L[h % L.length]; h = Math.floor(h / L.length) ^ (h << 7 >>> 0); h >>>= 0; }
  return `${s} ${String(1000 + (h % 9000)).padStart(4, '0')}`;
}
