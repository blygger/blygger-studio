import { excerptFromHtml, plainTextFromHtml, renderMarkdown } from "./markdown.ts";
import { clampText } from "./preview.ts";
import { annotateGenerated, applyGeneratedWrappers, parseScopes, previewStrip, type TkScope } from "./tk.ts";
import { resolveTarget } from "./transclusion.ts";

/** One `![[id]]` in a scope's instruction, as generate would resolve it: named for the editor, or why it would fail. */
export interface ScopeSourceSummary {
  id: string;
  ok: boolean;
  /** Where it comes from: "you", or the subscription's title for a remote source (decision #44). */
  from?: string;
  /** Present for a remote source: its author is told when the generated text is published. */
  remote?: boolean;
  excerpt?: string;
  reason?: string;
}

/**
 * scopeSummaries plus each scope's sources, resolved by the rule generate
 * uses, so the editor can say "draws on Friend's Blyg: …" or name a failure
 * before the author spends a generation on it.
 */
export async function scopeSummariesWithSources(db: D1Database, scopes: TkScope[]) {
  const titles = new Map<string, string>();
  const title = async (origin: string) => {
    if (!titles.has(origin)) {
      const row = await db.prepare("SELECT title FROM subscriptions WHERE origin = ? LIMIT 1").bind(origin).first<{ title: string }>();
      titles.set(origin, row?.title || new URL(origin).host);
    }
    return titles.get(origin)!;
  };
  const summaries = scopeSummaries(scopes);
  return Promise.all(
    summaries.map(async (summary, i) => {
      const sources: ScopeSourceSummary[] = [];
      for (const id of scopes[i].sourceIds) {
        const resolved = await resolveTarget(db, id);
        if (!resolved.ok) {
          sources.push({ id, ok: false, reason: resolved.reason });
          continue;
        }
        const { target } = resolved;
        sources.push({
          id,
          ok: true,
          from: target.origin ? await title(target.origin) : "you",
          ...(target.origin ? { remote: true } : {}),
          excerpt: excerptFromHtml(target.contentHtml, 60),
        });
      }
      return { ...summary, sources };
    }),
  );
}
export function scopeSummaries(scopes: TkScope[]): { index: number; instruction: string; output: string | null; hasOutput: boolean; block: boolean; imported: boolean }[] {
  return scopes.map((s, index) => ({
    index,
    instruction: s.instruction,
    output: s.output === null ? null : clampText(plainTextFromHtml(renderMarkdown(s.output)), 60),
    hasOutput: s.output !== null,
    block: s.block,
    imported: !!s.imported,
  }));
}

/**
 * Studio preview rendering for fragment and thread requests: strips TK
 * scopes (tolerantly — previewStrip never throws), highlights every resolved
 * scope regardless of real provenance (an authoring aid, not the wire's
 * disclosure rule — see model.ts publish() for the provenance-gated version),
 * and lets the caller render the remaining markdown (plain, or via
 * previewTransclusions for threads).
 */
export function annotateTkPreview(contentMd: string): { scopes: TkScope[]; text: string; blocks: Map<string, string>; finish: (renderedHtml: string) => string } {
  const { scopes } = parseScopes(contentMd);
  const { text, spans } = previewStrip(contentMd, scopes);
  const annotated = annotateGenerated(text, spans, spans.map(() => true));
  return { scopes, text: annotated.text, blocks: annotated.blockReplacements, finish: (renderedHtml) => applyGeneratedWrappers(renderedHtml, annotated) };
}
