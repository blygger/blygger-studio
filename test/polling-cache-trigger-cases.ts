/** Handwritten receiving witnesses for the SQLite prototype's nine-table event
 * envelope, plus read_state (migration 0026: Reading carries readVersion) and
 * mentions_in/mentions_out (0032: the mentions and responses domains).
 * These expected domains come from response dependencies, not the production
 * trigger generator. Working-copy edits deliberately exclude Reading.
 */
export const triggerFamilies = [
  { table: 'items', insert: "INSERT INTO items(id,created,updated) VALUES('matrix-item','t','t')", update: "UPDATE items SET status='public',version=1 WHERE id='matrix-item'", remove: "DELETE FROM items WHERE id='matrix-item'", domains: ['items', 'reading', 'feed'] },
  { table: 'versions', insert: "INSERT INTO versions(item_id,version,content_md,content_hash,published_at) VALUES('matrix-item',1,'body','hash','t')", update: "UPDATE versions SET note='new' WHERE item_id='matrix-item'", remove: "DELETE FROM versions WHERE item_id='matrix-item'", domains: ['items', 'reading', 'feed'] },
  { table: 'media', insert: "INSERT INTO media(id,item_id,r2_key,mime,created) VALUES('matrix-media','matrix-item','/media/matrix','image/png','t')", update: "UPDATE media SET alt='alt' WHERE id='matrix-media'", remove: "DELETE FROM media WHERE id='matrix-media'", domains: ['items', 'feed'] },
  { table: 'settings', insert: "INSERT INTO settings(key,value) VALUES('timezone','UTC')", update: "UPDATE settings SET value='America/Denver' WHERE key='timezone'", remove: "DELETE FROM settings WHERE key='timezone'", domains: ['settings', 'feed'] },
  { table: 'subscriptions', insert: "INSERT INTO subscriptions(id,kind,origin,feed_url,created) VALUES('matrix-sub','blyg','https://matrix/','https://matrix/feed.xml','t')", update: "UPDATE subscriptions SET origin='https://changed/' WHERE id='matrix-sub'", remove: "DELETE FROM subscriptions WHERE id='matrix-sub'", domains: ['subscriptions', 'reading', 'hoppers', 'feed'] },
  { table: 'imported_items', insert: "INSERT INTO imported_items(subscription_id,remote_id,kind,state,version,observed_at) VALUES('matrix-sub','matrix-remote','fragment','current',1,'t')", update: "UPDATE imported_items SET page='/f/matrix-remote' WHERE remote_id='matrix-remote'", remove: "DELETE FROM imported_items WHERE remote_id='matrix-remote'", domains: ['reading', 'hoppers', 'feed'] },
  { table: 'hoppers', insert: "INSERT INTO hoppers(id,name,created) VALUES('matrix-hopper','name','t')", update: "UPDATE hoppers SET description='description' WHERE id='matrix-hopper'", remove: "DELETE FROM hoppers WHERE id='matrix-hopper'", domains: ['hoppers'] },
  { table: 'hopper_items', insert: "INSERT INTO hopper_items(hopper_id,subscription_id,remote_id,added_at) VALUES('matrix-hopper','matrix-sub','matrix-remote','t')", update: "UPDATE hopper_items SET added_at='later' WHERE hopper_id='matrix-hopper'", remove: "DELETE FROM hopper_items WHERE hopper_id='matrix-hopper'", domains: ['hoppers'] },
  { table: 'signals', insert: "INSERT INTO signals(subscription_id,remote_id,thumb,at) VALUES('matrix-sub','matrix-remote',1,'t')", update: "UPDATE signals SET thumb=-1 WHERE subscription_id='matrix-sub'", remove: "DELETE FROM signals WHERE subscription_id='matrix-sub'", domains: ['signals'] },
  { table: 'read_state', insert: "INSERT INTO read_state(subscription_id,remote_id,read_version,updated) VALUES('matrix-sub','matrix-remote',1,'t')", update: "UPDATE read_state SET read_version=2,updated='later' WHERE subscription_id='matrix-sub'", remove: "DELETE FROM read_state WHERE subscription_id='matrix-sub'", domains: ['reading'] },
  // 0032: a verified, unhidden inbound row is on both the Studio list and the
  // public responses list; an outbound row is on the Studio list only. The
  // status-dependent branches have their own receiving witness in the oracle.
  { table: 'mentions_in', insert: "INSERT INTO mentions_in(id,source,target,target_item_id,status,first_seen,last_seen) VALUES('matrix-mention','https://m/s','https://us/f/matrix-item/','matrix-item','verified','t','t')", update: "UPDATE mentions_in SET source_author_json='{}' WHERE id='matrix-mention'", remove: "DELETE FROM mentions_in WHERE id='matrix-mention'", domains: ['mentions', 'responses'] },
  { table: 'mentions_out', insert: "INSERT INTO mentions_out(id,item_id,version,target,status,created) VALUES('matrix-out','matrix-item',1,'https://them/','pending','t')", update: "UPDATE mentions_out SET status='sent',attempts=1 WHERE id='matrix-out'", remove: "DELETE FROM mentions_out WHERE id='matrix-out'", domains: ['mentions'] },
  { table: 'interactions', insert: "INSERT INTO interactions(at,kind,origin,remote_id) VALUES('t','thumb_up','https://matrix-log/','remote')", update: "UPDATE interactions SET backfilled=1 WHERE origin='https://matrix-log/'", remove: "DELETE FROM interactions WHERE origin='https://matrix-log/'", domains: ['interactions'] },
  { table: 'browse_log', insert: "INSERT INTO browse_log(at,trail,origin,remote_id,via) VALUES('t','matrix-trail','https://matrix-log/','remote','start')", update: "UPDATE browse_log SET title='title' WHERE trail='matrix-trail'", remove: "DELETE FROM browse_log WHERE trail='matrix-trail'", domains: ['browse'] },
  // 0047: a syndication row is on the live item document and its public page (§16.14); never the feed.
  { table: 'item_syndication', insert: "INSERT INTO item_syndication(item_id,url,version,position) VALUES('matrix-item','https://copy.example/p',1,0)", update: "UPDATE item_syndication SET position=1 WHERE item_id='matrix-item'", remove: "DELETE FROM item_syndication WHERE item_id='matrix-item'", domains: ['items'] },
] as const;

// Independent one-field branches that the SQLite prototype supplied in SQL
// beyond its named examples. Keep these explicit so removing a field from the
// production effect classification cannot silently weaken its own test oracle.
export const triggerFields = [
  { family: 4, field: 'title_auto', value: 0, domains: ['subscriptions'] },
  ...['created','updated','forked_from','fork_cite','id','kind','version'].map(field => ({ family: 0, field, value: field === 'kind' ? 'thread' : field === 'version' ? 2 : field === 'id' ? 'renamed' : 'changed', domains: ['items','reading','feed'] })),
  ...['id','origin','title'].map(field => ({ family: 4, field, value: 'changed', domains: ['subscriptions','reading','hoppers','feed'] })),
  // A clear's tombstone alone (0026) is a Reading change: it decides whether a later read applies.
  { family: 9, field: 'unread_at', value: 'later', domains: ['reading'] },
  ...['subscription_id','remote_id','kind','page'].map(field => ({ family: 5, field, value: field === 'kind' ? 'thread' : 'changed', domains: ['reading','hoppers','feed'] })),
  // Every column of a listed, public inbound row is on both lists' side of the guard.
  ...['source','target','target_item_id','relation','source_origin','source_id','source_kind','source_page','source_author_json','first_seen','last_seen','verified_at','error','id'].map(field => ({ family: 10, field, value: 'changed', domains: ['mentions','responses'] })),
  ...['source_version','attempts'].map(field => ({ family: 10, field, value: 7, domains: ['mentions','responses'] })),
  // Leaving the public set is a public change; the Studio still lists the row.
  { family: 10, field: 'hidden', value: 1, domains: ['mentions','responses'] },
  { family: 10, field: 'status', value: 'gone', domains: ['mentions','responses'] },
  ...['endpoint','last_error','next_attempt_at','target','created','id','item_id'].map(field => ({ family: 11, field, value: 'changed', domains: ['mentions'] })),
  ...['version','target_version','attempts'].map(field => ({ family: 11, field, value: 7, domains: ['mentions'] })),
];
