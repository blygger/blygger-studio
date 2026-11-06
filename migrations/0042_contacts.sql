-- The address book (tn-6 section 5.1): studio-private. A handle never leaves the
-- studio; ids_json holds [{ "id": uri, "provenance": "self"|"bound"|"entered" }].
CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  ids_json TEXT NOT NULL DEFAULT '[]',
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
