-- Hopper subscriptions (PROPOSED, pending Fable: blygger-spec protocol-v0.4.md
-- §12.1 step 7, §12.2, §13.5a; fable-round-queue item 14). A subscription to
-- one public hopper's feed at another blyg, created only while the
-- `hopper_feeds` setting is on.
--
-- §12.2: its identity is the pair (identity origin, hopper feed URL), "a
-- subscription to a list at an origin, not a second origin". So the row keeps
-- `origin` = the blyg's identity origin, the same value a whole-blyg
-- subscription to it has, and `hopper_feed` = the feed's URL as the manifest
-- names it (also its `feed_url`). It is `kind = 'rss'`: its entries are L0
-- rows (§13.5a rule 5). Where the manifest lives, for the daily "still
-- listed?" check, is the existing `surface` column, as for a blyg. NULL
-- hopper_feed = not a hopper subscription. Every query that means "the whole
-- blyg at this origin" adds `hopper_feed IS NULL` (docs/hopper-feeds.md).
ALTER TABLE subscriptions ADD COLUMN hopper_feed TEXT;

-- One subscription per (origin, hopper_feed). The whole-blyg half (NULL
-- hopper_feed, one per origin) stays enforced where it is today, by the
-- subscribe route's 409 (findSubscription): a unique index over it would abort
-- this migration on any node still holding a pre-0.26.1 duplicate
-- subscription, which the route did not refuse until then.
CREATE UNIQUE INDEX subscriptions_hopper_identity ON subscriptions (origin, hopper_feed) WHERE hopper_feed IS NOT NULL;

-- The polling cache's change trigger (0024, 0025) lists every column it
-- watches, and an oracle test holds it to the table's full column set.
-- Recreated with hopper_feed added; otherwise identical to 0025's.
DROP TRIGGER IF EXISTS change_subscriptions_update;
CREATE TRIGGER change_subscriptions_update
AFTER UPDATE ON subscriptions
WHEN OLD."created" IS NOT NEW."created" OR OLD."etag" IS NOT NEW."etag" OR OLD."fail_count" IS NOT NEW."fail_count" OR OLD."feed_url" IS NOT NEW."feed_url" OR OLD."flags" IS NOT NEW."flags" OR OLD."id" IS NOT NEW."id" OR OLD."in_blogroll" IS NOT NEW."in_blogroll" OR OLD."kind" IS NOT NEW."kind" OR OLD."last_index_sync_at" IS NOT NEW."last_index_sync_at" OR OLD."last_modified" IS NOT NEW."last_modified" OR OLD."last_poll_at" IS NOT NEW."last_poll_at" OR OLD."newest_guid" IS NOT NEW."newest_guid" OR OLD."origin" IS NOT NEW."origin" OR OLD."status" IS NOT NEW."status" OR OLD."title" IS NOT NEW."title" OR OLD."title_auto" IS NOT NEW."title_auto" OR OLD."surface" IS NOT NEW."surface" OR OLD."hopper_feed" IS NOT NEW."hopper_feed"
BEGIN
  SELECT RAISE(ABORT, 'missing change state') WHERE NOT EXISTS(SELECT 1 FROM change_state WHERE id=1);
  UPDATE change_state SET
    reading=reading+(CASE WHEN (OLD."id" IS NOT NEW."id" OR OLD."origin" IS NOT NEW."origin" OR OLD."title" IS NOT NEW."title") THEN 1 ELSE 0 END),
    subscriptions=subscriptions+(1),
    hoppers=hoppers+(CASE WHEN (OLD."id" IS NOT NEW."id" OR OLD."origin" IS NOT NEW."origin" OR OLD."title" IS NOT NEW."title") THEN 1 ELSE 0 END),
    feed=feed+(CASE WHEN (OLD."id" IS NOT NEW."id" OR OLD."origin" IS NOT NEW."origin" OR OLD."title" IS NOT NEW."title") THEN 1 ELSE 0 END)
  WHERE id=1;
END;
