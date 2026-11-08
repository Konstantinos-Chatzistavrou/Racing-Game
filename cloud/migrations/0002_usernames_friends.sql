-- Usernames: unique regardless of case (web/src/username.ts has the rules); NULL until the player picks one.
ALTER TABLE accounts ADD COLUMN username TEXT;
ALTER TABLE accounts ADD COLUMN username_at INTEGER;   -- when it was last changed (one change per 30 days)
ALTER TABLE accounts ADD COLUMN seen INTEGER;          -- last presence heartbeat (ms): "online" to friends
ALTER TABLE accounts ADD COLUMN party TEXT;            -- the party code the player is in (friends may join it)
CREATE UNIQUE INDEX accounts_username ON accounts (username COLLATE NOCASE);
-- Friends: one row per direction. A request is (from -> to, 'pending'); accepting makes both rows 'friends'.
CREATE TABLE friends (a TEXT NOT NULL, b TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (a, b));
CREATE INDEX friends_b ON friends (b, state);
