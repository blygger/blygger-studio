// /api/items/{id}/generate business logic (tk-core-plan.md §5 task 4) —
// factored out of the Hono route so tests can inject a fixture provider
// fetch, the same DI pattern importer/schedule.ts uses for runScheduledPoll.

import { generate, markDocument, platformProviderFetch, ProviderError, AiBudgetError, type ProviderFetchLike } from "./ai/provider.ts";
import { selectionText } from "./markdown.ts";
import { getSettings, saveWorkingCopy, setTkProvenance } from "./model.ts";
import { composeStubCite } from "./stub.ts";
import { parseScopes, setScopeOutput } from "./tk.ts";
import { resolveTarget, type ResolvedTarget } from "./transclusion.ts";
import type { Env, GenerationSource, ItemRow } from "./types.ts";
import { nowIso } from "./util.ts";

/**
 * What a generator is fed for one source: the local snapshot (0.3 §16.3),
 * never a live fetch. A fragment's markdown is its text. A thread's markdown
 * holds bare `![[id]]` directives, so it is fed as its reader sees it — the
 * baked snapshot, quotes included, as text with its block breaks kept. An
 * imported item whose origin sent no markdown is fed the same way.
 */
function sourceText(target: ResolvedTarget): string {
  if (target.kind === "fragment" && target.contentMd.trim()) return target.contentMd;
  return selectionText(target.contentHtml);
}

export type GenerateScopeResult =
  /** `text` is the scope's new output alone; `content_md` is the whole working copy with it spliced in, as saved. */
  | { ok: true; text: string; model: string; content_md: string }
  | { ok: false; status: number; body: Record<string, unknown> };

export async function runGenerateScope(
  env: Env,
  item: ItemRow,
  scopeIndex: number,
  fetchImpl: ProviderFetchLike = platformProviderFetch,
  /** This blyg's origin, for the cite of a source that turns out to be our own under another subscription. */
  ourOrigin?: string,
): Promise<GenerateScopeResult> {
  const { scopes, errors: parseErrors } = parseScopes(item.content_md);
  if (parseErrors.length) {
    return { ok: false, status: 400, body: { error: "working copy has malformed TK scopes", errors: parseErrors } };
  }
  const scope = scopes[scopeIndex];
  if (!scope) return { ok: false, status: 400, body: { error: "unknown scope index" } };
  if (scope.imported) return { ok: false, status: 400, body: { error: "an impyrt scope holds text generated elsewhere; it is not regenerated here" } };

  // Every source resolves by the rule a directive uses (§10.2's order, 0.3
  // §16.3, decision #44): one of our published items, then an imported item
  // with a current or pin-retained snapshot. No selfId: a source bakes
  // nothing, so there is no cycle to refuse, the same reasoning as `[[id]]`.
  const settings = await getSettings(env.DB);
  const at = nowIso();
  const sources: (GenerationSource & { text: string })[] = [];
  for (const id of scope.sourceIds) {
    const resolved = await resolveTarget(env.DB, id);
    if (!resolved.ok) return { ok: false, status: 400, body: { error: `unresolvable source: ${resolved.reason}`, id, reason: resolved.reason } };
    const { target } = resolved;
    const ref: GenerationSource = { id, version: target.version };
    // A remote source carries its origin and its frozen human half, composed
    // now, when the words were read, so publish emits the stored object and a
    // later rename of the subscription cannot rewrite it (as for a remote
    // transclusion's cite, decision #30).
    if (target.origin) {
      ref.origin = target.origin;
      ref.cited = await composeStubCite(env.DB, { origin: target.origin, id, version: target.version }, ourOrigin ?? "", settings.site_title, at);
    }
    sources.push({ ...ref, text: sourceText(target) });
  }

  let result;
  try {
    result = await generate(
      env,
      {
        instruction: scope.instruction,
        currentText: scope.output,
        sources: sources.map(({ id, text }) => ({ id, content_md: text })),
        documentContext: markDocument(item.content_md, scope.start, scope.end),
        stylePrompt: settings.ai_style_prompt || null,
      },
      fetchImpl,
    );
  } catch (e) {
    if (e instanceof AiBudgetError) return { ok: false, status: 429, body: { error: e.message } };
    if (e instanceof ProviderError) return { ok: false, status: 502, body: { error: e.message } };
    throw e;
  }

  const updatedMd = setScopeOutput(item.content_md, scope, result.text);
  await saveWorkingCopy(env.DB, item.id, updatedMd);
  await setTkProvenance(env.DB, item.id, scopeIndex, scopes.length, {
    sources: sources.map(({ text: _text, ...ref }) => ref),
    model: result.model,
    at,
  });

  return { ok: true, text: result.text, model: result.model, content_md: updatedMd };
}
