-- Keep an imported item's `generated` array (0.3 §5.7, §16.3; decision #44),
-- verbatim as the origin published it, sources' `origin` and `cited` included.
-- The importer kept `transclusions`, `stub_of` and `forked_from` and dropped
-- this one, so a generated item's provenance did not survive import, which is
-- what gate G8's exercise checks (v0.4-plan §7.2 R8c). NULL for rows imported
-- before this migration until the origin's next version, and for items that
-- disclose no generation.
ALTER TABLE imported_items ADD COLUMN generated_json TEXT;

-- The polling cache's change trigger (0024) lists every column it watches, and
-- an oracle test holds it to the table's full column set. Recreated with
-- `generated_json` added; otherwise identical to 0024's.
DROP TRIGGER IF EXISTS change_imported_items_update;
CREATE TRIGGER change_imported_items_update
AFTER UPDATE ON imported_items
WHEN OLD."author_json" IS NOT NEW."author_json" OR OLD."content_hash" IS NOT NEW."content_hash" OR OLD."content_html" IS NOT NEW."content_html" OR OLD."content_md" IS NOT NEW."content_md" OR OLD."created" IS NOT NEW."created" OR OLD."forked_from_json" IS NOT NEW."forked_from_json" OR OLD."generated_json" IS NOT NEW."generated_json" OR OLD."kind" IS NOT NEW."kind" OR OLD."l0" IS NOT NEW."l0" OR OLD."media_json" IS NOT NEW."media_json" OR OLD."observed_at" IS NOT NEW."observed_at" OR OLD."page" IS NOT NEW."page" OR OLD."pinned_version_retained" IS NOT NEW."pinned_version_retained" OR OLD."remote_id" IS NOT NEW."remote_id" OR OLD."state" IS NOT NEW."state" OR OLD."stub_of_json" IS NOT NEW."stub_of_json" OR OLD."subscription_id" IS NOT NEW."subscription_id" OR OLD."transclusions_json" IS NOT NEW."transclusions_json" OR OLD."updated" IS NOT NEW."updated" OR OLD."version" IS NOT NEW."version"
BEGIN
  SELECT RAISE(ABORT, 'missing change state') WHERE NOT EXISTS(SELECT 1 FROM change_state WHERE id=1);
  UPDATE change_state SET
    reading=reading+(1),
    hoppers=hoppers+(1),
    feed=feed+(CASE WHEN (OLD."kind" IS NOT NEW."kind" OR OLD."page" IS NOT NEW."page" OR OLD."remote_id" IS NOT NEW."remote_id" OR OLD."subscription_id" IS NOT NEW."subscription_id") THEN 1 ELSE 0 END)
  WHERE id=1;
END;
