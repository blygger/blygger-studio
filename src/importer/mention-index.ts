// The Mentions lens's index: which identifiers an imported item's own h-cards name.
import { normalizeMentionTarget } from "../mention-targets.ts";

const CARD_URL = ".h-card .u-url, a.h-card";

/** Identifiers in `html`'s h-cards. A baked quote's are the quoted author's speech, and are left out (tn-6 section 6). */
export async function mentionTargets(html: string): Promise<string[]> {
  if (!html.includes("h-card")) return [];
  const found = new Set<string>();
  let quoted = false;
  const add = {
    element(el: Element) {
      const value = el.getAttribute("href") ?? el.getAttribute("value");
      if (value && !quoted) found.add(normalizeMentionTarget(value));
      quoted = false;
    },
  };
  // Handlers for one element run in the order registered, so the first can veto the second.
  const rewriter = new HTMLRewriter()
    .on(CARD_URL.split(", ").map((s) => `blockquote.blyg-transclusion ${s}`).join(", "), { element() { quoted = true; } })
    .on(CARD_URL, add);
  await rewriter.transform(new Response(html)).text();
  return [...found].slice(0, 50);
}

export async function syncImportedMentions(db: D1Database, subscriptionId: string, remoteId: string, html: string | null): Promise<void> {
  const targets = html ? await mentionTargets(html) : [];
  await db.batch([
    db.prepare("DELETE FROM imported_mentions WHERE subscription_id = ? AND remote_id = ?").bind(subscriptionId, remoteId),
    ...targets.map((target) =>
      db.prepare("INSERT OR IGNORE INTO imported_mentions (subscription_id, remote_id, target) VALUES (?, ?, ?)").bind(subscriptionId, remoteId, target)),
  ]);
}

/** Read items imported before the index existed, a page per cron. Costs one query once it is finished. */
export async function backfillImportedMentions(db: D1Database, limit = 500): Promise<number> {
  const mark = await db.prepare("SELECT after FROM imported_mentions_backfill WHERE id = 1").first<{ after: number }>();
  if (!mark) return 0;
  const { results } = await db
    .prepare("SELECT rowid AS rid, subscription_id AS sub, remote_id AS remote, content_html AS html FROM imported_items WHERE rowid > ? AND l0 = 0 AND state != 'tombstone' ORDER BY rowid LIMIT ?")
    .bind(mark.after, limit)
    .all<{ rid: number; sub: string; remote: string; html: string | null }>();
  for (const row of results) {
    if (row.html?.includes("h-card")) await syncImportedMentions(db, row.sub, row.remote, row.html);
  }
  if (results.length < limit) await db.prepare("DELETE FROM imported_mentions_backfill WHERE id = 1").run();
  else await db.prepare("UPDATE imported_mentions_backfill SET after = ? WHERE id = 1").bind(results[results.length - 1].rid).run();
  return results.length;
}
