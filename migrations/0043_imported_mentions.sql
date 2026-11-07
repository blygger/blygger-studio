-- Who an imported item names in its own words (tn-6 section 6, #91): each h-card's
-- identifiers, outside baked quotes, recorded at import so the Mentions lens never
-- has to scan stored HTML. Studio-private, and nothing was verified.
CREATE TABLE imported_mentions (
  subscription_id TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  target TEXT NOT NULL,
  PRIMARY KEY (subscription_id, remote_id, target)
);
CREATE INDEX imported_mentions_target ON imported_mentions(target, subscription_id, remote_id);

-- One row while items imported before this table are still to be read; the cron
-- walks them by rowid and deletes the row when done.
CREATE TABLE imported_mentions_backfill (id INTEGER PRIMARY KEY CHECK (id = 1), after INTEGER NOT NULL DEFAULT 0);
INSERT INTO imported_mentions_backfill (id, after) VALUES (1, 0);
