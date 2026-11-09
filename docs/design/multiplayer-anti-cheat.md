# Multiplayer + anti-cheat: what to build and what it costs (2026-11-09)

## Verdict

Cloudflare is the right home for this game's scale, and it is free for a long while yet. What exists today is an
authoritative *tracker* (4 Hz positions into a Durable Object, one per party, validated and paid server-side); the
cars themselves still stream peer-to-peer. "Full multiplayer" means the room relays state instead of only watching it.

A Forza-Horizon-5-class anti-cheat is **not achievable in a browser** - there is no kernel driver, the client is
attacker-controlled, and the player can edit JS. The achievable target is the same one every browser competitive game
ships: server-authoritative rules, plausibility checks, replay re-simulation for the top results, and a strike system.

## The free tier, measured against a race

Cloudflare Workers Free + Durable Objects (SQLite backend only on Free), October 2026 numbers:

| limit | free allowance | what one 6-player, 5-minute race uses |
|---|---|---|
| DO requests (incl. WebSocket messages, 20 incoming = 1 request) | 100,000 / day | 6 players x 4 Hz x 300 s / 20 = ~360, plus joins |
| DO duration | 13,000 GB-s / day | 300 s x ~0.13 GB = ~39 GB-s -> ~330 races/day |
| DO storage | 5 GB total, 1 GB per object | race rooms are ephemeral; the D1 career is small |
| Workers requests | 100,000 / day | one per API call / account / race result |

At 15 Hz relayed state instead of 4 Hz tracking, one 10-minute race is ~54,000 incoming messages -> ~2,700 requests
and ~77 GB-s: still inside the free day, and **outgoing WebSocket messages are not charged at all** - which is the
whole reason a relay is affordable here.

What is *not* free: a Workers Paid plan at $5/month raises the DO ceiling (1M requests/month, 400k GB-s) if the game
ever needs more than ~300 race-hours a day. That is the upgrade path, not a rewrite.

## What "full multiplayer" needs

1. **Relay, not mesh.** The Durable Object broadcasts each car's state (position, quaternion, speed, inputs flags) at
   10-15 Hz to the other players in the room; the client interpolates and extrapolates. PeerJS stays only as a
   fallback. Outgoing messages are free, so the relay is cheaper than the P2P mesh is reliable.
2. **Prediction and reconciliation.** The local car is simulated immediately; the server sends authoritative state;
   the client re-simulates from the last acknowledged input. Without this, 15 Hz feels like 15 Hz.
3. **Matchmaking.** A public list in D1 (party code, mode, laps, players, region) and a join endpoint; the party code
   flow already exists, this just exposes it.
4. **Authority for the things that matter.** The room already owns the clock, the order and the payout. Extend it to
   own damage and reset decisions, so a client cannot claim a repair it did not do.
5. **Reconnect + join-in-progress**, both of which the Durable Object model makes easy (one object per room, sleeping
   when empty).

## Anti-cheat, in the order that pays

1. **Never trust the client for money or rank** - already true: server decides the result, ownership and payouts.
2. **Plausibility per tick** - already partially true: speed vs. the car's top speed, teleports, flood limits, contact.
   Add: acceleration envelope, lateral grip envelope, damage-state consistency, and a per-sector minimum time.
3. **Replay re-simulation** for the top 3 of every ranked race. The blocker is determinism, not the server: the same
   scripted drive diverges 1.3 m in 15 s because the fixed-step loop is fed by wall-clock deltas and the city streams
   on its own schedule. Fix: record inputs against tick numbers, simulate with a fixed dt, and make collision tiles
   deterministic (preload the race's tiles before the countdown). That alone turns the existing replay endpoints on.
4. **Client-integrity signals** - build hash, WebGPU/UA fingerprint, impossible input timing - as flags for review,
   never as proof (they are spoofable).
5. **Strikes and ranking gates** - already in place (3 violations = no reward, 3 strikes = no ranked).

## If Cloudflare stops being the right answer

Leave when one of these is true, in this order: (a) more than ~300 race-hours a day, (b) a need for a 60 Hz
server-authoritative simulation with server-side physics, (c) cross-region rooms where a region-pinned Durable Object
adds too much latency. Then a single always-free VM (Oracle Cloud's Arm free tier, 4 OCPU / 24 GB) running a Go or
Node relay is the cheapest step, with Cloudflare still in front for auth, D1 and TLS. Do not move before (a): the free
tier is a real budget, not a trial.

## Capacity, corrected and priced (2026-11-09)

My earlier '~300 race-hours a day free' was wrong by an order of magnitude: the free plan is 100,000 DO requests per
day, and one 6-player room at 15 Hz relay bills 90 messages/s / 20 = 4.5 requests/s = 16,200 requests per room-hour.
The honest numbers, per 6-player room:

| | 4 Hz (tracking, today) | 15 Hz (relay, full multiplayer) |
|---|---|---|
| requests per room-hour | 4,320 | 16,200 |
| duration per room-hour (128 MB) | 461 GB-s | 461 GB-s |
| Free plan, per day (100k req / 13k GB-s) | ~23 room-hours | ~6 room-hours |
| Free plan, per month | ~690 room-hours | ~185 room-hours |
| Workers Paid $5: included | 1M req + 400k GB-s | 1M req + 400k GB-s |
| Workers Paid $5: room-hours included | ~231 | **~62** |
| cost beyond included | ~$0.006/room-hour | ~$0.008/room-hour |

The counter-intuitive part: the **free** plan's monthly request allowance (~3M, 100k/day) is *larger* than the paid
plan's included 1M - the $5 buys the right to exceed it without a hard stop, not a bigger base. Free fails at 00:00
UTC; paid meters at $0.15/million requests and $12.50/million GB-s.

Concurrency is not capped by Cloudflare; you pay per room-hour. Examples at 15 Hz, 8 h/day, 30 days:

| rooms | players | room-hours/month | bill |
|---|---|---|---|
| 1 | 6 | 240 | ~$6.5 |
| 10 | 60 | 2,400 | ~$19 |
| 17 | 100 | 4,080 | ~$33 |

## The alternatives, with their real free limits

| option | free realtime allowance | authoritative rooms | verdict |
|---|---|---|---|
| **Cloudflare DO** | 100k req/day, 13k GB-s/day | yes (it is the room) | best fit: stateful room, storage, no egress bill |
| Supabase Realtime | 200 connections but **100 messages/s** | no | one 15 Hz room saturates the cap; lobby/presence only |
| Ably | 500 connections, 6M messages/month | no | 6M / 90 msg/s = ~18 room-hours/month |
| Firebase RTDB | 100 simultaneous connections, ~10 GB/month download | no | no server authority, no anti-cheat story |
| Oracle Always Free VM | 4 OCPU / 24 GB ARM, 10 TB egress | yes, full control | the only real 'better' - unlimited messages, own physics; costs ops |
| Colyseus (self-host) | framework, no hosting | yes | pairs well with the Oracle VM |

Verdict unchanged for now: Cloudflare is the best free-tier option for authoritative rooms at this scale, and at
$0.008 per room-hour the paid plan is cheap long before it matters. Move to an Oracle free VM only when you need a
60 Hz server-side simulation or unlimited relay traffic - that is a determinism/anti-cheat decision, not a price one.
