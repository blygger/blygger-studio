-- Speculative authoring (studio-only, no wire change): an item created by
-- typing `[[some text]]` in the editor is a placeholder draft, and this is the
-- label it was created with. NULL for every other item. An item is an *open*
-- placeholder while this is set and it has never been published (version 0);
-- the column is kept after publish so the studio can still tell where an item
-- came from. Never read by any public surface.
ALTER TABLE items ADD COLUMN placeholder_label TEXT;

-- The open-placeholder list (version 0 with a label) reads this.
CREATE INDEX items_placeholder ON items(placeholder_label) WHERE placeholder_label IS NOT NULL;

-- Every items column takes part in the change trigger's guard
-- (polling-cache.oracle); the label is studio-private, so it bumps items only.
DROP TRIGGER change_items_update;
CREATE TRIGGER change_items_update
AFTER UPDATE ON items
WHEN OLD."content_md" IS NOT NEW."content_md" OR OLD."created" IS NOT NEW."created" OR OLD."dirty" IS NOT NEW."dirty" OR OLD."fork_cite" IS NOT NEW."fork_cite" OR OLD."forked_from" IS NOT NEW."forked_from" OR OLD."highlight_override" IS NOT NEW."highlight_override" OR OLD."id" IS NOT NEW."id" OR OLD."kind" IS NOT NEW."kind" OR OLD."responses_override" IS NOT NEW."responses_override" OR OLD."show_responses" IS NOT NEW."show_responses" OR OLD."status" IS NOT NEW."status" OR OLD."stub_of" IS NOT NEW."stub_of" OR OLD."tk_provenance_json" IS NOT NEW."tk_provenance_json" OR OLD."updated" IS NOT NEW."updated" OR OLD."version" IS NOT NEW."version" OR OLD."revision" IS NOT NEW."revision" OR OLD."placeholder_label" IS NOT NEW."placeholder_label"
BEGIN
  SELECT RAISE(ABORT, 'missing change state') WHERE NOT EXISTS(SELECT 1 FROM change_state WHERE id=1);
  UPDATE change_state SET
    items=items+(1),
    reading=reading+(CASE WHEN (OLD.status IN ('public','withdrawn') OR NEW.status IN ('public','withdrawn')) AND (OLD."created" IS NOT NEW."created" OR OLD."fork_cite" IS NOT NEW."fork_cite" OR OLD."forked_from" IS NOT NEW."forked_from" OR OLD."id" IS NOT NEW."id" OR OLD."kind" IS NOT NEW."kind" OR OLD."status" IS NOT NEW."status" OR OLD."updated" IS NOT NEW."updated" OR OLD."version" IS NOT NEW."version") THEN 1 ELSE 0 END),
    feed=feed+(CASE WHEN ((OLD.status IN ('public','withdrawn') OR NEW.status IN ('public','withdrawn')) AND (OLD."created" IS NOT NEW."created" OR OLD."fork_cite" IS NOT NEW."fork_cite" OR OLD."forked_from" IS NOT NEW."forked_from" OR OLD."id" IS NOT NEW."id" OR OLD."kind" IS NOT NEW."kind" OR OLD."status" IS NOT NEW."status" OR OLD."updated" IS NOT NEW."updated" OR OLD."version" IS NOT NEW."version")) OR OLD."id" IS NOT NEW."id" OR OLD."kind" IS NOT NEW."kind" THEN 1 ELSE 0 END)
  WHERE id=1;
END;

