-- NULL preserves legacy interpretation when retained data cannot establish intent.
-- Old Workers can still insert NULL during the migration/deploy window.
ALTER TABLE versions ADD COLUMN kind TEXT CHECK(kind IN ('fragment', 'thread', 'withdrawn'));

DROP TRIGGER change_versions_update;
CREATE TRIGGER change_versions_update
AFTER UPDATE ON versions
WHEN OLD."kind" IS NOT NEW."kind" OR OLD."content_hash" IS NOT NEW."content_hash" OR OLD."content_html" IS NOT NEW."content_html" OR OLD."content_md" IS NOT NEW."content_md" OR OLD."generated_json" IS NOT NEW."generated_json" OR OLD."item_id" IS NOT NEW."item_id" OR OLD."note" IS NOT NEW."note" OR OLD."note_generated" IS NOT NEW."note_generated" OR OLD."pinned" IS NOT NEW."pinned" OR OLD."pinned_at" IS NOT NEW."pinned_at" OR OLD."published_at" IS NOT NEW."published_at" OR OLD."stub_cite" IS NOT NEW."stub_cite" OR OLD."stub_of" IS NOT NEW."stub_of" OR OLD."transclusions" IS NOT NEW."transclusions" OR OLD."version" IS NOT NEW."version"
BEGIN
  SELECT RAISE(ABORT, 'missing change state') WHERE NOT EXISTS(SELECT 1 FROM change_state WHERE id=1);
  UPDATE change_state SET
    items=items+(1),
    reading=reading+(CASE WHEN (OLD."kind" IS NOT NEW."kind" OR OLD."content_hash" IS NOT NEW."content_hash" OR OLD."content_html" IS NOT NEW."content_html" OR OLD."content_md" IS NOT NEW."content_md" OR OLD."item_id" IS NOT NEW."item_id" OR OLD."note" IS NOT NEW."note" OR OLD."note_generated" IS NOT NEW."note_generated" OR OLD."published_at" IS NOT NEW."published_at" OR OLD."stub_cite" IS NOT NEW."stub_cite" OR OLD."stub_of" IS NOT NEW."stub_of" OR OLD."transclusions" IS NOT NEW."transclusions" OR OLD."version" IS NOT NEW."version") THEN 1 ELSE 0 END),
    feed=feed+(CASE WHEN (OLD."kind" IS NOT NEW."kind" OR OLD."content_hash" IS NOT NEW."content_hash" OR OLD."content_html" IS NOT NEW."content_html" OR OLD."content_md" IS NOT NEW."content_md" OR OLD."item_id" IS NOT NEW."item_id" OR OLD."note" IS NOT NEW."note" OR OLD."note_generated" IS NOT NEW."note_generated" OR OLD."published_at" IS NOT NEW."published_at" OR OLD."stub_cite" IS NOT NEW."stub_cite" OR OLD."stub_of" IS NOT NEW."stub_of" OR OLD."transclusions" IS NOT NEW."transclusions" OR OLD."version" IS NOT NEW."version") THEN 1 ELSE 0 END)
  WHERE id=1;
END;

-- Backfill only facts supported by the retained snapshot or current item.
-- Never rewrite the frozen publication fields.
UPDATE versions SET kind = CASE
  WHEN EXISTS (SELECT 1 FROM items i WHERE i.id = versions.item_id AND i.version = versions.version AND i.status = 'withdrawn' AND i.kind = 'withdrawn' AND versions.content_md = '') THEN 'withdrawn'
  WHEN EXISTS (SELECT 1 FROM items i WHERE i.id = versions.item_id AND i.version = versions.version AND i.status = 'public' AND i.kind = 'fragment' AND versions.transclusions IS NULL) THEN 'fragment'
  WHEN CASE WHEN json_valid(transclusions) THEN json_type(transclusions) = 'array' ELSE 0 END THEN 'thread'
  WHEN content_md != '' AND transclusions IS NULL THEN 'fragment'
  ELSE NULL END;
