-- The blygs the reader has met but does not follow (blygger-spec
-- docs/agentic-digest-plan.md §8 law 4; form B, Venkat, session 92): written
-- whole by the built-in digest's daily discovery (src/agentic-discovery.ts),
-- read by every edition and by the Agentic feed's resolution of `remote`
-- entries, so neither touches the network.
--
-- One row per met origin, neither followed nor the owner's own, at the last
-- discovery: met in the reading (`met` references from held items and
-- verified mention sources) or listed in the blygger.com directory (`listed`,
-- with the listing's `title`). `sample_id` and `sample_created` are set for an
-- origin whose feed that discovery read and found active: its newest item
-- created in the last 14 days. Nothing of the item is stored; it is read
-- through /peek when opened.
--
-- Studio-private and derived: the next discovery rebuilds it, so it is not
-- in a backup.
CREATE TABLE met_origins (
  origin TEXT PRIMARY KEY,
  met INTEGER NOT NULL,
  listed INTEGER NOT NULL,
  title TEXT,
  sample_id TEXT,
  sample_created TEXT,
  checked_at TEXT NOT NULL
);
