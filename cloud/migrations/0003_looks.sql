-- Car looks (the garage's paint parts and colours, web/src/custom-data.ts) kept with the account, so the same car
-- follows the player to another device and both careers share it. One JSON object: car id -> Custom. Validated on
-- write (POST /v1/look) against the shared module the game draws from; capped so an account cannot store junk.
ALTER TABLE accounts ADD COLUMN looks TEXT NOT NULL DEFAULT '{}';
