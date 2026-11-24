-- The byline is stored, not built at serve time (blygger-spec docs/multi-author-plan.md §4, M1).
-- Until now `author` was built from settings each time a document was served, so a
-- settings change rewrote the byline of every published item, pinned files included,
-- whose bytes are meant to be permanent. From here a version keeps the `author`
-- object it was published with. NULL is a version published before this migration:
-- it is served as before, from settings, so nothing anyone fetches changes today.
-- `items.author_id` says whose item it is; every item is the owner's until people exist (M3).
ALTER TABLE versions ADD COLUMN author_json TEXT;
ALTER TABLE private_versions ADD COLUMN author_json TEXT;
ALTER TABLE items ADD COLUMN author_id TEXT NOT NULL DEFAULT 'owner';
