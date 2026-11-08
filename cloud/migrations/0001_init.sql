-- Online career. Accounts are anonymous (random id + hashed secret token); provider / provider_id are reserved for an
-- optional Google / GitHub / Discord sign-in later. net = salted hash of the network (IPv4 address or IPv6 /64).
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  created INTEGER NOT NULL,
  xp INTEGER NOT NULL DEFAULT 0,
  credits INTEGER NOT NULL DEFAULT 0,
  cars TEXT NOT NULL DEFAULT '[]',
  mods TEXT NOT NULL DEFAULT '{}',
  skins TEXT NOT NULL DEFAULT '[]',
  clean INTEGER NOT NULL DEFAULT 100,
  strikes INTEGER NOT NULL DEFAULT 0,
  banned INTEGER NOT NULL DEFAULT 0,
  net TEXT,
  provider TEXT,
  provider_id TEXT
);
-- earnings per account per UTC day (daily caps)
CREATE TABLE daily (account TEXT NOT NULL, day TEXT NOT NULL, xp INTEGER NOT NULL DEFAULT 0, cr INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account, day));
-- ranked races raced together per pair per day (repeat-opponent diminishing returns)
CREATE TABLE opponents (account TEXT NOT NULL, opponent TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account, opponent, day));
-- new accounts per network per day
CREATE TABLE signups (net TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (net, day));
CREATE TABLE races (id TEXT PRIMARY KEY, created INTEGER NOT NULL, party TEXT NOT NULL, laps INTEGER NOT NULL, ranked INTEGER NOT NULL, result TEXT NOT NULL);
-- replay checks: the server asks top finishers for their input recording; a GitHub Actions job re-runs it
CREATE TABLE replays (race TEXT NOT NULL, account TEXT NOT NULL, requested INTEGER NOT NULL, claimed_ms INTEGER NOT NULL, data TEXT, status TEXT NOT NULL DEFAULT 'requested', PRIMARY KEY (race, account));
CREATE TABLE reports (race TEXT NOT NULL, reporter TEXT NOT NULL, player TEXT NOT NULL, why TEXT NOT NULL, created INTEGER NOT NULL);
