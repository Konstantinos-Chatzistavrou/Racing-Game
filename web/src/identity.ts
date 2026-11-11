// The player's username (username.ts has the rules) and friends.
//
// The username is how friends find a player and how everyone recognises them in races: the leaderboard, the name tag over a
// remote car, the number plate (when it fits). It is unique on the online service (cloud/): picking one claims it for this
// device's account there (the account is created on the spot). The server is the authority: a username the account already
// has wins over the one stored in this browser. Without an online service (a build without VITE_CLOUD_URL, or offline) the
// name is kept here and claimed the next time the service answers; uniqueness cannot be checked until then.
import type { Cloud, Friends, Profile } from './cloud';
import { saveSelection, type Selection } from './garage';
import { usernameError } from './username';

const CLAIMED_KEY = 'nr.username.claimed';   // the name this browser's account holds on the server ('' = none confirmed)

export class Identity {
  /** server-confirmed for this account */
  claimed = false;
  /** why the stored name is not ours (taken by someone else, server error) */
  note = '';
  friends: Friends = { friends: [], incoming: [], outgoing: [] };
  friendsNote = '';
  /** when the friends list was fetched (ms): "last seen" ages from here */
  friendsAt = 0;
  onChange = () => {};
  private heartbeat = 0;

  constructor(private sel: Selection, readonly cloud: Cloud) {
    try { this.claimed = !!this.sel.name && localStorage.getItem(CLAIMED_KEY) === this.sel.name; } catch { /* storage blocked */ }
  }

  get name() { return this.sel.name; }
  /** no valid username yet: the title asks for one before anything else */
  get needsPick() { return usernameError(this.sel.name) !== null; }

  private keep(name: string, claimed: boolean) {
    this.sel.name = name; this.claimed = claimed;
    saveSelection(this.sel);
    try { localStorage.setItem(CLAIMED_KEY, claimed ? name : ''); } catch { /* storage blocked */ }
  }

  /** Live check for the input: '' = fine (and free, when the service can tell), else the reason. */
  async check(u: string): Promise<string> {
    const err = usernameError(u);
    if (err) return err;
    if (!this.cloud.available || u.toLowerCase() === this.sel.name.toLowerCase()) return '';
    try { const r = await this.cloud.usernameFree(u); return r.ok ? '' : r.error ?? 'Not available.'; } catch { return ''; }
  }

  /** Pick or change the username. Returns '' on success, else the reason. */
  async pick(u: string): Promise<string> {
    u = u.trim();
    const err = usernameError(u);
    if (err) return err;
    if (!this.cloud.available) { this.keep(u, false); this.note = ''; this.onChange(); return ''; }
    try {
      const p = await this.cloud.claimUsername(u);
      this.keep(p.username ?? u, true); this.note = '';
      this.onChange();
      return '';
    } catch (e) {
      const msg = (e as Error).message;
      // service unreachable: keep it here, claim later
      if (/fetch|network|Failed|HTTP 5/i.test(msg)) { this.keep(u, false); this.note = 'Saved on this device; it is claimed when the online service answers.'; this.onChange(); return ''; }
      return msg;
    }
  }

  /** The online profile loaded: adopt the account's username, or claim the one picked here. */
  async sync(p: Profile | null) {
    if (!p) return;
    if (p.username) {
      if (p.username !== this.sel.name || !this.claimed) { this.keep(p.username, true); this.note = ''; this.onChange(); }
      return;
    }
    if (this.needsPick) return;
    try { const q = await this.cloud.claimUsername(this.sel.name); this.keep(q.username ?? this.sel.name, true); this.note = ''; }
    catch (e) { this.claimed = false; this.note = `"${this.sel.name}": ${(e as Error).message} Pick another one.`; }
    this.onChange();
  }

  async loadFriends() {
    if (!this.cloud.available || !this.cloud.id) { this.friendsNote = this.cloud.available ? '' : 'Friends need the online service, which is not set up for this build.'; return; }
    try { this.friends = await this.cloud.friends(); this.friendsAt = Date.now(); this.friendsNote = ''; }
    catch (e) { this.friendsNote = `Online service unreachable: ${(e as Error).message}`; }
    this.onChange();
  }

  async friend(u: string, action: 'add' | 'accept' | 'remove'): Promise<string> {
    if (!this.cloud.available) return 'Friends need the online service.';
    if (!this.claimed) return 'Your username is not confirmed by the online service yet.';
    try {
      const r = await this.cloud.friend(u.trim(), action);
      await this.loadFriends();
      return action === 'add' ? (r.state === 'friends' ? `✓ You and ${u} are friends.` : `✓ Request sent to ${u}.`) : '';
    } catch (e) { return (e as Error).message; }
  }

  /** Presence every 60 s while the page is open (and at once when the party changes). */
  startPresence(party: () => string | null) {
    const beat = () => { if (this.cloud.available && this.cloud.id && this.claimed && !document.hidden) void this.cloud.presence(party()).catch(() => {}); };
    clearInterval(this.heartbeat);
    this.heartbeat = window.setInterval(beat, 60_000);
    beat();
    return beat;
  }
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "12 days ago", then a date. */
export function agoText(ms: number, now = Date.now()): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  return new Date(now - ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
