import { OperationError, type OperationContext } from "./operation-types.ts";
import { createDraft, getItem, getSettings, getVersion } from "./model.ts";
import { parseStubOf } from "./stub.ts";
import { normalizeSelection, quoteLines } from "./markdown.ts";
import { locateSelection } from "./transclusion.ts";
import { getSubscription, getImportedItem, OWN_SUBSCRIPTION } from "./importer/store.ts";
import { siteOrigin } from "./protocol.ts";
import { sourceTitleAndUrl } from "./importer/util.ts";
import { normalizeMount, nowIso } from "./util.ts";

/**
 * The stub action (v0.3-plan §3.1, decision #27) — one gesture, replacing
 * `respond`. Creates a **thread** draft citing exactly one target and opens
 * in the editor; the body is prefilled but entirely the author's to change.
 *
 * A blyg target gets the transclusion directive, because a stub without the
 * quote is not a stub in this medium's aesthetic. An L0 target gets the old
 * respond prefill — a markdown link and nothing else — keeping respond's one
 * real discipline: none of *their* text is copied.
 *
 * `stub_of` is set regardless of whether the body ends up quoting the target:
 * readers rely on the marker, never on body inspection (§2.2).
 *
 * **Partial quotation (§10.1)** changes only the prefill. With a `selection`,
 * the body is the directive plus that passage as an attached blockquote,
 * checked here against the snapshot we hold, so a selection that cannot
 * publish is refused when it is made rather than at publish. Without one the
 * body quotes the whole item, whatever its length (session 37, Venkat: the
 * opening passage was rarely the passage wanted). The reference client no
 * longer sends a selection; it chooses passages in the stub editor instead,
 * but the API keeps the parameter.
 *
 * Both are prefill only. The body remains entirely the author's to change, and
 * `stub_of` is set the same way in every case.
 */
export async function createResponseDraft(context: OperationContext, body: { subscription_id: string; remote_id: string; selection?: string }) {
  const subId = body.subscription_id;
  const remoteId = body.remote_id;
  if (!subId || !remoteId) throw new OperationError('invalid-input', "subscription_id and remote_id required");
  if (subId === OWN_SUBSCRIPTION) return createOwnResponseDraft(context, remoteId, body.selection);
  const sub = await getSubscription(context.env.DB, subId);
  if (!sub) throw new OperationError('not-found', "subscription not found");
  const row = await getImportedItem(context.env.DB, subId, remoteId);
  if (!row) throw new OperationError('not-found', "imported item not found");

  let contentMd: string;
  let stubInput: unknown;
  if (row.l0) {
    const { title, url } = sourceTitleAndUrl(row, sub.origin);
    const label = (title || sub.title || sub.origin).replace(/[[\]]/g, "");
    contentMd = `[${label}](${url})\n\n`;
    // The citation's human half, frozen now (§5.9, decision #55): which feed,
    // and the entry's own title as the caption — more than a hostname says.
    stubInput = {
      url,
      cited: { source: sub.title || "", ...(title ? { excerpt: title } : {}), url, retrieved: nowIso() },
    };
  } else {
    // What a quote of this row would bake: the retained pinned version for a
    // tombstone we kept, the watermark otherwise. An unretained tombstone has
    // no bytes to quote, so the citation stands alone — a response to a
    // withdrawal is legitimate (§2.3.6), it just cannot include the text.
    const quotable = row.state === "current" || row.pinned_version_retained !== null;
    const version = row.state === "tombstone" && row.pinned_version_retained !== null ? row.pinned_version_retained : row.version;
    if (!quotable) {
      contentMd = "";
    } else if (typeof body.selection === "string" && body.selection.trim()) {
      const selection = normalizeSelection(body.selection);
      // Checked now, against the same bytes publish will check against. The
      // alternative — prefill it and find out later — hands the author a draft
      // that cannot be published and no hint as to which part is wrong.
      if (!selection || !locateSelection(row.content_html, selection)) {
        throw new OperationError('invalid-input', "that passage is not in the version we hold of this item");
      }
      contentMd = `![[${remoteId}]]\n${quoteLines(selection)}\n\n`;
    } else {
      contentMd = `![[${remoteId}]]\n\n`;
    }
    stubInput = { origin: sub.origin, id: remoteId, version };
  }

  const parsed = parseStubOf(stubInput);
  if (!parsed.ok) throw new OperationError('invalid-input', parsed.reason);
  return createDraft(context.env.DB, contentMd, "thread", parsed.stub);
}

/**
 * Stubbing one of the owner's own items from the reading feed (session 50,
 * Venkat). The same draft as an imported target's, addressed `~own` as hoppers
 * address own items: a same-origin `stub_of` (§10.6) at the live version,
 * which sends no mention (§15.2). A withdrawn item has no bytes to quote, so
 * the citation stands alone, as for an unretained tombstone.
 */
async function createOwnResponseDraft(context: OperationContext, id: string, selection?: string) {
  const item = await getItem(context.env.DB, id);
  if (!item || item.version === 0) throw new OperationError('not-found', "published item not found");
  const origin = siteOrigin(await getSettings(context.env.DB), context.url, normalizeMount(context.env.MOUNT));
  let contentMd = "";
  if (item.status === "public") {
    if (typeof selection === "string" && selection.trim()) {
      const version = await getVersion(context.env.DB, id, item.version);
      const normalized = normalizeSelection(selection);
      if (!version || !normalized || !locateSelection(version.content_html ?? "", normalized)) {
        throw new OperationError('invalid-input', "that passage is not in the published version of this item");
      }
      contentMd = `![[${id}]]\n${quoteLines(normalized)}\n\n`;
    } else {
      contentMd = `![[${id}]]\n\n`;
    }
  }
  const parsed = parseStubOf({ origin, id, version: item.version });
  if (!parsed.ok) throw new OperationError('invalid-input', parsed.reason);
  return createDraft(context.env.DB, contentMd, "thread", parsed.stub);
}
