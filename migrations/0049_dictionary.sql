-- The dictionary: words this blyg's spellchecking accepts, kept on the server so
-- every client and device shares them, through GET /api/dictionary and
-- PUT /api/dictionary/{source}. Studio-private: no item document, feed,
-- manifest, public page or static export reads these tables.
--
-- A word belongs to a source: "owner" for the words the author adds, any other
-- name for a set an extension or client installs (a technical domain, say), so
-- a set can be replaced or removed without touching the rest.
-- dictionary_revision is the whole dictionary's revision for conditional PUTs
-- (expectedRevision); every successful PUT bumps it.
CREATE TABLE dictionary (
  source TEXT NOT NULL,
  word TEXT NOT NULL,
  PRIMARY KEY (source, word)
);

CREATE TABLE dictionary_revision (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision >= 0)
);
INSERT INTO dictionary_revision(id, revision) VALUES(1, 0);
