-- Private concurrency identity. This is independent of public version numbers.
ALTER TABLE items ADD COLUMN revision INTEGER NOT NULL DEFAULT 1
  CHECK (revision >= 1 AND revision <= 9007199254740991);

-- Private item reads include revision; public projections do not.
DROP TRIGGER change_items_update;
CREATE TRIGGER change_items_update
AFTER UPDATE ON items
WHEN OLD."content_md" IS NOT NEW."content_md" OR OLD."created" IS NOT NEW."created" OR OLD."dirty" IS NOT NEW."dirty" OR OLD."fork_cite" IS NOT NEW."fork_cite" OR OLD."forked_from" IS NOT NEW."forked_from" OR OLD."highlight_override" IS NOT NEW."highlight_override" OR OLD."id" IS NOT NEW."id" OR OLD."kind" IS NOT NEW."kind" OR OLD."responses_override" IS NOT NEW."responses_override" OR OLD."show_responses" IS NOT NEW."show_responses" OR OLD."status" IS NOT NEW."status" OR OLD."stub_of" IS NOT NEW."stub_of" OR OLD."tk_provenance_json" IS NOT NEW."tk_provenance_json" OR OLD."updated" IS NOT NEW."updated" OR OLD."version" IS NOT NEW."version" OR OLD."revision" IS NOT NEW."revision"
BEGIN
  SELECT RAISE(ABORT, 'missing change state') WHERE NOT EXISTS(SELECT 1 FROM change_state WHERE id=1);
  UPDATE change_state SET
    items=items+(1),
    reading=reading+(CASE WHEN (OLD.status IN ('public','withdrawn') OR NEW.status IN ('public','withdrawn')) AND (OLD."created" IS NOT NEW."created" OR OLD."fork_cite" IS NOT NEW."fork_cite" OR OLD."forked_from" IS NOT NEW."forked_from" OR OLD."id" IS NOT NEW."id" OR OLD."kind" IS NOT NEW."kind" OR OLD."status" IS NOT NEW."status" OR OLD."updated" IS NOT NEW."updated" OR OLD."version" IS NOT NEW."version") THEN 1 ELSE 0 END),
    feed=feed+(CASE WHEN ((OLD.status IN ('public','withdrawn') OR NEW.status IN ('public','withdrawn')) AND (OLD."created" IS NOT NEW."created" OR OLD."fork_cite" IS NOT NEW."fork_cite" OR OLD."forked_from" IS NOT NEW."forked_from" OR OLD."id" IS NOT NEW."id" OR OLD."kind" IS NOT NEW."kind" OR OLD."status" IS NOT NEW."status" OR OLD."updated" IS NOT NEW."updated" OR OLD."version" IS NOT NEW."version")) OR OLD."id" IS NOT NEW."id" OR OLD."kind" IS NOT NEW."kind" THEN 1 ELSE 0 END)
  WHERE id=1;
END;

