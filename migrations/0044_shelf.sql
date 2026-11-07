-- The shelf (#135): the owner's short, ordered list of their own items, synced
-- across clients through GET/PUT /api/shelf. Studio-private: no item document,
-- feed, manifest, public page or static export reads these tables.
--
-- shelf holds one row per item, ordered by position. shelf_revision is the
-- list's own revision for conditional PUTs (expectedRevision); every successful
-- PUT bumps it. Both move the `shelf` change domain.
--
-- A discarded draft is deleted from items, and its shelf row goes with it. A
-- withdrawn item keeps its row but GET omits it, so a withdrawal on a shelved
-- item also moves the domain.
--
-- Guards are SELECT RAISE ... WHERE and no CASE closed by END and a semicolon
-- (0024, session 37).
ALTER TABLE change_state ADD COLUMN shelf INTEGER NOT NULL DEFAULT 0 CHECK(typeof(shelf)='integer' AND shelf BETWEEN 0 AND 9007199254740991);

CREATE TABLE shelf (
  item_id TEXT PRIMARY KEY,
  position INTEGER NOT NULL
);
CREATE INDEX shelf_order ON shelf(position, item_id);

CREATE TABLE shelf_revision (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision >= 0)
);
INSERT INTO shelf_revision(id, revision) VALUES(1, 0);

CREATE TRIGGER change_shelf_insert
AFTER INSERT ON shelf
BEGIN
  SELECT RAISE(ABORT, 'missing change state') WHERE NOT EXISTS(SELECT 1 FROM change_state WHERE id=1);
  UPDATE change_state SET shelf=shelf+1 WHERE id=1;
END;

CREATE TRIGGER change_shelf_update
AFTER UPDATE ON shelf
WHEN OLD."item_id" IS NOT NEW."item_id" OR OLD."position" IS NOT NEW."position"
BEGIN
  SELECT RAISE(ABORT, 'missing change state') WHERE NOT EXISTS(SELECT 1 FROM change_state WHERE id=1);
  UPDATE change_state SET shelf=shelf+1 WHERE id=1;
END;

CREATE TRIGGER change_shelf_delete
AFTER DELETE ON shelf
BEGIN
  SELECT RAISE(ABORT, 'missing change state') WHERE NOT EXISTS(SELECT 1 FROM change_state WHERE id=1);
  UPDATE change_state SET shelf=shelf+1 WHERE id=1;
END;

CREATE TRIGGER change_shelf_revision_insert
AFTER INSERT ON shelf_revision
BEGIN
  SELECT RAISE(ABORT, 'missing change state') WHERE NOT EXISTS(SELECT 1 FROM change_state WHERE id=1);
  UPDATE change_state SET shelf=shelf+1 WHERE id=1;
END;

CREATE TRIGGER change_shelf_revision_update
AFTER UPDATE ON shelf_revision
WHEN OLD."id" IS NOT NEW."id" OR OLD."revision" IS NOT NEW."revision"
BEGIN
  SELECT RAISE(ABORT, 'missing change state') WHERE NOT EXISTS(SELECT 1 FROM change_state WHERE id=1);
  UPDATE change_state SET shelf=shelf+1 WHERE id=1;
END;

CREATE TRIGGER change_shelf_revision_delete
AFTER DELETE ON shelf_revision
BEGIN
  SELECT RAISE(ABORT, 'missing change state') WHERE NOT EXISTS(SELECT 1 FROM change_state WHERE id=1);
  UPDATE change_state SET shelf=shelf+1 WHERE id=1;
END;

-- Withdrawing a shelved item takes it off GET /shelf.
CREATE TRIGGER change_items_shelf_status
AFTER UPDATE OF status ON items
WHEN (OLD.status='withdrawn') IS NOT (NEW.status='withdrawn') AND EXISTS(SELECT 1 FROM shelf WHERE item_id=NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'missing change state') WHERE NOT EXISTS(SELECT 1 FROM change_state WHERE id=1);
  UPDATE change_state SET shelf=shelf+1 WHERE id=1;
END;

-- A discarded draft leaves the shelf (change_shelf_delete moves the domain).
CREATE TRIGGER shelf_items_delete
AFTER DELETE ON items
BEGIN
  DELETE FROM shelf WHERE item_id=OLD.id;
END;
