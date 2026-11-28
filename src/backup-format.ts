// The backup archive's shape, shared by the studio's download (backup.ts) and
// `npm run backup` (scripts/backup.ts), so both write one format and a future
// restore (ROADMAP row 53) reads one. No Worker types: the UI suite imports it.

export const BACKUP_FORMAT = 'blygger-studio-backup';
export const BACKUP_FORMAT_VERSION = 1;

/** The owner's content and the studio's own state: what a backup holds. */
export const BACKUP_TABLES: ReadonlySet<string> = new Set([
  'agentic_feeds', 'browse_log', 'change_class', 'change_state', 'changelog_summaries', 'contacts', 'dictionary', 'dictionary_revision', 'helper_results', 'hopper_items', 'hoppers',
  'imported_change_queue', 'imported_items', 'imported_mentions', 'imported_mentions_backfill', 'interactions', 'item_syndication', 'items', 'link_probe',
  'media', 'mentions_in', 'mentions_out', 'private_versions', 'read_state', 'reading_order', 'reading_order_state', 'reading_placement', 'settings', 'shelf', 'shelf_revision', 'signals', 'subscriptions', 'version_media', 'versions',
]);
/** Migration tables deliberately left out: credentials, grants and abuse budgets. */
export const CREDENTIAL_TABLES: ReadonlySet<string> = new Set([
  'oauth_authorizations', 'oauth_records', 'oauth_revocations', 'oauth_state', 'rateLimit', 'security_budgets', 'security_registrations',
]);

/** Derived state: search is rebuilt from restored source rows by migration 0050's triggers, and met_origins by the next daily discovery (0066). */
export const DERIVED_TABLES: ReadonlySet<string> = new Set([
  'met_origins', 'search_documents', 'search_fts', 'search_fts_data', 'search_fts_idx', 'search_fts_docsize', 'search_fts_config',
]);

/** Everything not on the allow-list stays on the node. */
export function excludedTable(name: string): boolean {
  return !BACKUP_TABLES.has(name);
}

export interface TableCount { rows: number; files: number }
export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  client: string;
  clientVersion: string;
  createdAt: string;
  origin: string;
  mount: string;
  migration: string | null;
  tables: Record<string, TableCount>;
  excludedTables: string[];
  media: { objects: number; bytes: number };
  complete: true;
}

/** `blyg-backup-example.com-blyg-2026-11-14.tar`: host, mount and day, so two nodes' backups never share a name. */
export function backupFileName(origin: string, mount: string, now: Date): string {
  const host = new URL(origin).host.replace(/[^a-z0-9.-]/gi, '-');
  const path = mount.replace(/^\//, '').replace(/[^a-z0-9.-]/gi, '-');
  return `blyg-backup-${host}${path ? '-' + path : ''}-${now.toISOString().slice(0, 10)}.tar`;
}
