# OpenGrid online service

The server of the **online career**: accounts, XP, credits, purchases, and the race rooms that time ranked party races.
It runs on Cloudflare's free plan (Workers + D1 + SQLite-backed Durable Objects). No servers to maintain; going over a
free daily limit makes requests fail until 00:00 UTC (results wait in the players' browsers), never a bill.

Licence: AGPL-3.0-or-later, like the game's code.

## What it does

- **Accounts**: anonymous (random id + secret token, hashed on the server). No e-mail, no password; the recovery code
  (Settings → Online account) moves an account to another device. At most 5 new accounts per network per day.
- **Online career**: XP, level, credits and owned items live in the database; the game only shows them. Purchases are
  checked here (online level + credits; a conditional update so credits can never be spent twice).
- **Ranked races**: the party's race room (one Durable Object per party code) receives every car's position ~4 times a
  second, times the laps itself (`src/tracker.ts`, same rules as the core's race tracker), decides the order, and pays.
  - counts only if **6+ accounts genuinely raced**, at most **2 per network** (IPv4 address, or IPv6 /64 = one household)
  - checks: average speed vs. the car's real top speed, teleports, resets (none in full realism; never gaining distance),
    message floods, car-to-car contact (clean-race bonus). 3 violations = no reward + a strike; 3 strikes = no ranked races
  - new accounts earn half (first 24 h and below level 3); racing the same opponents 5+ / 10+ times a day pays half / a
    quarter; daily caps (80,000 XP, 150,000 Cr); level-ups pay credits
  - the rules and numbers are in `web/src/progression.ts`, shared with the game
- Raw IP addresses are never stored: only a salted hash of the network.

## Develop and test (no Cloudflare account needed)

```
cd cloud
npm install
npm run db:local          # create the local database
npm run dev               # http://127.0.0.1:8787 (the game's dev server uses it automatically)
npm test                  # 15 simulated players, two real-time races (~2 min)
```

`.dev.vars` (not committed) for local runs: `ALLOW_TEST_IP=1`, `IP_SALT=dev-salt`, `VERIFIER_KEY=dev-verifier`.
**Never set `ALLOW_TEST_IP` in production** (it lets a client pick its network for tests).

## Go live (once)

1. A free Cloudflare account (dash.cloudflare.com), then in this folder: `npx wrangler login`
2. `npx wrangler d1 create opengrid` and put the printed `database_id` into `wrangler.toml`
3. `npx wrangler secret put IP_SALT` (any long random string) and `npx wrangler secret put VERIFIER_KEY`
4. `npm run db:remote && npm run deploy` → prints the service URL (`https://opengrid.<your-subdomain>.workers.dev`;
   pick a neutral subdomain)
5. In Vercel: environment variable `VITE_CLOUD_URL` = that URL, redeploy the game

## Not done yet

**Replay checks** (re-running the top results from recorded inputs to catch modified physics). The server already asks
the top 3 of every ranked race for a recording and has the endpoints for a checker; what is missing is a game simulation
that is exactly reproducible from inputs (measured: the same scripted drive in two sessions ends 1.3 m apart after
15 s; the city's collision tiles stream in on their own schedule). Until then nothing is voided by replays.
