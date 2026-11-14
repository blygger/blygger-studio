-- `syndication` (spec 0.4 §16.14, decision #98): copies of an item that its
-- publisher made on other networks, each a URL and the version it copies.
-- A ruled shape awaiting its gate; this migration is the build side of it.
--
-- item_syndication holds the owner's own entries, one row per copy, ordered by
-- position. They are written in place and never make a version: the live item
-- document carries them, and pinned files and withdrawal endcaps never do. A
-- row change moves the `items` domain, which is what public pages and the
-- item document are read under; never `feed`, because nothing is added to the
-- feed (§16.14 rule 2). A discarded draft cannot have rows (a draft has no
-- version to copy), and a deleted item takes its rows with it.
--
-- imported_items.syndication_json keeps a held item's member as the reader
-- last fetched it, filtered to https: entries (rule 5). NULL when the origin
-- published none.
--
-- Guards are SELECT RAISE ... WHERE, with no CASE closed by END and a
-- semicolon (0024, session 37).
CREATE TABLE item_syndication (
  item_id TEXT NOT NULL,
  url TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version >= 1),
  position INTEGER NOT NULL,
  PRIMARY KEY (item_id, url)
);
CREATE INDEX item_syndication_order ON item_syndication(item_id, position);

CREATE TRIGGER change_item_syndication_insert
AFTER INSERT ON item_syndication
BEGIN
  SELECT RAISE(ABORT, 'missing change state') WHERE NOT EXISTS(SELECT 1 FROM change_state WHERE id=1);
  UPDATE change_state SET items=items+1 WHERE id=1;
END;

CREATE TRIGGER change_item_syndication_update
AFTER UPDATE ON item_syndication
WHEN OLD."item_id" IS NOT NEW."item_id" OR OLD."url" IS NOT NEW."url" OR OLD."version" IS NOT NEW."version" OR OLD."position" IS NOT NEW."position"
BEGIN
  SELECT RAISE(ABORT, 'missing change state') WHERE NOT EXISTS(SELECT 1 FROM change_state WHERE id=1);
  UPDATE change_state SET items=items+1 WHERE id=1;
END;

CREATE TRIGGER change_item_syndication_delete
AFTER DELETE ON item_syndication
BEGIN
  SELECT RAISE(ABORT, 'missing change state') WHERE NOT EXISTS(SELECT 1 FROM change_state WHERE id=1);
  UPDATE change_state SET items=items+1 WHERE id=1;
END;

CREATE TRIGGER item_syndication_items_delete
AFTER DELETE ON items
BEGIN
  DELETE FROM item_syndication WHERE item_id=OLD.id;
END;

ALTER TABLE imported_items ADD COLUMN syndication_json TEXT;

-- The polling cache's change trigger lists every column it watches, and an
-- oracle test holds it to the table's full column set. Recreated with
-- `syndication_json` added; otherwise identical to 0027's.
DROP TRIGGER IF EXISTS change_imported_items_update;
CREATE TRIGGER change_imported_items_update
AFTER UPDATE ON imported_items
WHEN OLD."author_json" IS NOT NEW."author_json" OR OLD."content_hash" IS NOT NEW."content_hash" OR OLD."content_html" IS NOT NEW."content_html" OR OLD."content_md" IS NOT NEW."content_md" OR OLD."created" IS NOT NEW."created" OR OLD."forked_from_json" IS NOT NEW."forked_from_json" OR OLD."generated_json" IS NOT NEW."generated_json" OR OLD."kind" IS NOT NEW."kind" OR OLD."l0" IS NOT NEW."l0" OR OLD."media_json" IS NOT NEW."media_json" OR OLD."observed_at" IS NOT NEW."observed_at" OR OLD."page" IS NOT NEW."page" OR OLD."pinned_version_retained" IS NOT NEW."pinned_version_retained" OR OLD."remote_id" IS NOT NEW."remote_id" OR OLD."state" IS NOT NEW."state" OR OLD."stub_of_json" IS NOT NEW."stub_of_json" OR OLD."subscription_id" IS NOT NEW."subscription_id" OR OLD."syndication_json" IS NOT NEW."syndication_json" OR OLD."transclusions_json" IS NOT NEW."transclusions_json" OR OLD."updated" IS NOT NEW."updated" OR OLD."version" IS NOT NEW."version"
BEGIN
  SELECT RAISE(ABORT, 'missing change state') WHERE NOT EXISTS(SELECT 1 FROM change_state WHERE id=1);
  UPDATE change_state SET
    reading=reading+(1),
    hoppers=hoppers+(1),
    feed=feed+(CASE WHEN (OLD."kind" IS NOT NEW."kind" OR OLD."page" IS NOT NEW."page" OR OLD."remote_id" IS NOT NEW."remote_id" OR OLD."subscription_id" IS NOT NEW."subscription_id") THEN 1 ELSE 0 END)
  WHERE id=1;
END;
