-- AI summaries of an item's changelog (session 61). Studio-private: shown on an
-- item's own public page when Settings' changelog_display is "summary", and in
-- the reader when reader_changelog_display is; never in an item document, the
-- feed or the manifest. One row per item, replaced when the item moves past the
-- version it summarizes, so the table holds at most one summary per item.
--
-- subject: "own:{item id}" or "imp:{subscription id}:{remote id}".
-- status: "pending" while a generation holds the claim, "ready", or "failed"
-- (retried after a while; src/changelog-summary.ts).
--
-- Numbered 0045: 0044 is held by the shelf (studio#137), which may merge
-- first or after; D1 applies whichever is missing, in name order.
CREATE TABLE changelog_summaries (
  subject TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  summary TEXT,
  model TEXT,
  at TEXT NOT NULL
);
