-- One document per searchable copy, with a stable integer key for FTS5.
-- Keep the working copy and the current publication separate: an unpublished
-- edit can change what Compose finds without changing what the picker finds.
CREATE TABLE search_documents (
  rowid INTEGER PRIMARY KEY,
  scope TEXT NOT NULL,
  item_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  content_md TEXT NOT NULL,
  search_id TEXT GENERATED ALWAYS AS (lower(item_id)) VIRTUAL,
  search_body TEXT GENERATED ALWAYS AS (lower(content_md)) VIRTUAL,
  -- Delimit the hex bytes so a trigram match requires the entire subscription ID.
  search_subscription TEXT GENERATED ALWAYS AS (':' || hex(subscription_id) || ':') VIRTUAL,
  UNIQUE (scope, item_id, subscription_id)
);

CREATE VIRTUAL TABLE search_fts USING fts5(
  scope, search_id, search_body, search_subscription,
  content='search_documents', content_rowid='rowid', tokenize='trigram case_sensitive 1'
);

-- The same eligibility rules serve the backfill and subsequent writes.
CREATE VIEW search_source(scope, item_id, subscription_id, content_md) AS
  SELECT 'working', i.id, '', i.content_md FROM items i
  WHERE i.status IN ('public', 'draft') AND i.kind IN ('fragment', 'thread')
  UNION ALL
  SELECT 'published', i.id, '', v.content_md FROM items i
  JOIN versions v ON v.item_id = i.id AND v.version = i.version
  WHERE i.status = 'public' AND i.kind IN ('fragment', 'thread')
  UNION ALL
  SELECT 'imported', ii.remote_id, ii.subscription_id, ii.content_md FROM imported_items ii
  WHERE ii.l0 = 0 AND (ii.state = 'current' OR ii.pinned_version_retained IS NOT NULL);

INSERT INTO search_documents(scope, item_id, subscription_id, content_md)
SELECT * FROM search_source;

INSERT INTO search_fts(rowid, scope, search_id, search_body, search_subscription)
SELECT rowid, scope, search_id, search_body, search_subscription FROM search_documents;

CREATE TRIGGER search_documents_insert AFTER INSERT ON search_documents
BEGIN
  INSERT INTO search_fts(rowid, scope, search_id, search_body, search_subscription)
  VALUES (NEW.rowid, NEW.scope, NEW.search_id, NEW.search_body, NEW.search_subscription);
END;

CREATE TRIGGER search_documents_delete AFTER DELETE ON search_documents
BEGIN
  INSERT INTO search_fts(search_fts, rowid, scope, search_id, search_body, search_subscription)
  VALUES ('delete', OLD.rowid, OLD.scope, OLD.search_id, OLD.search_body, OLD.search_subscription);
END;

CREATE TRIGGER search_items_insert AFTER INSERT ON items
BEGIN
  INSERT INTO search_documents(scope, item_id, subscription_id, content_md)
  SELECT * FROM search_source WHERE scope IN ('working', 'published') AND item_id = NEW.id;
END;

CREATE TRIGGER search_items_working_update AFTER UPDATE OF id, status, kind, content_md ON items
WHEN OLD.id IS NOT NEW.id OR OLD.status IS NOT NEW.status OR OLD.kind IS NOT NEW.kind
  OR OLD.content_md IS NOT NEW.content_md
BEGIN
  DELETE FROM search_documents WHERE scope = 'working' AND item_id = OLD.id;
  INSERT INTO search_documents(scope, item_id, subscription_id, content_md)
  SELECT * FROM search_source WHERE scope = 'working' AND item_id = NEW.id;
END;

CREATE TRIGGER search_items_published_update AFTER UPDATE OF id, status, kind, version ON items
WHEN OLD.id IS NOT NEW.id OR OLD.status IS NOT NEW.status OR OLD.kind IS NOT NEW.kind
  OR OLD.version IS NOT NEW.version
BEGIN
  DELETE FROM search_documents WHERE scope = 'published' AND item_id = OLD.id;
  INSERT INTO search_documents(scope, item_id, subscription_id, content_md)
  SELECT * FROM search_source WHERE scope = 'published' AND item_id = NEW.id;
END;

CREATE TRIGGER search_items_delete AFTER DELETE ON items
BEGIN
  DELETE FROM search_documents WHERE scope IN ('working', 'published') AND item_id = OLD.id;
END;

-- Publish normally inserts the version before advancing the item. Also
-- handle data loaded in the opposite order and changes to a current row.
CREATE TRIGGER search_versions_insert AFTER INSERT ON versions
WHEN EXISTS (SELECT 1 FROM items WHERE id = NEW.item_id AND version = NEW.version)
BEGIN
  INSERT INTO search_documents(scope, item_id, subscription_id, content_md)
  SELECT * FROM search_source WHERE scope = 'published' AND item_id = NEW.item_id;
END;

CREATE TRIGGER search_versions_update AFTER UPDATE OF item_id, version, content_md ON versions
WHEN OLD.item_id IS NOT NEW.item_id OR OLD.version IS NOT NEW.version OR OLD.content_md IS NOT NEW.content_md
BEGIN
  DELETE FROM search_documents WHERE scope = 'published' AND item_id = OLD.item_id
    AND EXISTS (SELECT 1 FROM items WHERE id = OLD.item_id AND version = OLD.version);
  INSERT INTO search_documents(scope, item_id, subscription_id, content_md)
  SELECT * FROM search_source WHERE scope = 'published' AND item_id = NEW.item_id
    AND EXISTS (SELECT 1 FROM items WHERE id = NEW.item_id AND version = NEW.version);
END;

CREATE TRIGGER search_versions_delete AFTER DELETE ON versions
WHEN EXISTS (SELECT 1 FROM items WHERE id = OLD.item_id AND version = OLD.version)
BEGIN
  DELETE FROM search_documents WHERE scope = 'published' AND item_id = OLD.item_id;
END;

CREATE TRIGGER search_imported_insert AFTER INSERT ON imported_items
BEGIN
  INSERT INTO search_documents(scope, item_id, subscription_id, content_md)
  SELECT * FROM search_source WHERE scope = 'imported' AND item_id = NEW.remote_id AND subscription_id = NEW.subscription_id;
END;

CREATE TRIGGER search_imported_update
AFTER UPDATE OF subscription_id, remote_id, l0, state, pinned_version_retained, content_md ON imported_items
WHEN OLD.subscription_id IS NOT NEW.subscription_id OR OLD.remote_id IS NOT NEW.remote_id
  OR OLD.l0 IS NOT NEW.l0 OR OLD.state IS NOT NEW.state
  OR (OLD.pinned_version_retained IS NULL) IS NOT (NEW.pinned_version_retained IS NULL)
  OR OLD.content_md IS NOT NEW.content_md
BEGIN
  DELETE FROM search_documents WHERE scope = 'imported' AND item_id = OLD.remote_id AND subscription_id = OLD.subscription_id;
  INSERT INTO search_documents(scope, item_id, subscription_id, content_md)
  SELECT * FROM search_source WHERE scope = 'imported' AND item_id = NEW.remote_id AND subscription_id = NEW.subscription_id;
END;

CREATE TRIGGER search_imported_delete AFTER DELETE ON imported_items
BEGIN
  DELETE FROM search_documents WHERE scope = 'imported' AND item_id = OLD.remote_id AND subscription_id = OLD.subscription_id;
END;
