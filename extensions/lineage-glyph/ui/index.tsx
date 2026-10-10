/*
 * lineage-glyph: the reading view's lineage glyph, hex view and action ring
 * (first built as #35), as a Studio extension (docs/extensions.md).
 *
 *   byline slot   the glyph: what a post draws on, and what draws on it here
 *   ⋯ slot        "lineage", a second way into the same sheet
 *   sheet         the hex view and action ring (lineage.tsx)
 *
 * Its counts and graph come from the extension's own owner reads
 * (/api/ext/lineage-glyph/…), through the SDK. The actions it offers for the
 * entry are the Studio's own handlers (context.actions); for a node it has
 * re-centred on, it builds the same drafts and navigation through the context.
 */
import { useEffect, useState } from 'react';
import type { EntryContext, StudioExtension } from '../../../src/ui/extension-api.ts';
import { BlyggerApi, unwrap } from '../../../src/ui/extension-api.ts';
import type { BlyggerClient, LineageGlyphLineage, LineageGlyphSummary } from '../../../sdk/dist/browser.js';
import type { Handlers } from './lineage.tsx';
import { LineageGlyph, LineageSheet, glyphCounts, glyphLabel } from './lineage.tsx';

/* ---------------- glyph counts, one request per page ---------------- */

const FRESH_MS = 30_000;
const BATCH = 50;
const cache = new Map<string, { at: number; summary: Promise<LineageGlyphSummary | undefined> }>();
let batch: { keys: string[]; done: Promise<Record<string, LineageGlyphSummary>> } | null = null;

/**
 * The summary for one reading entry. Requests made in the same tick (a page of
 * bylines mounting) share one GET, so the timeline costs a single request.
 */
function summaryFor(client: BlyggerClient, key: string) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.summary;
  if (!batch || batch.keys.length >= BATCH) {
    const next: { keys: string[]; done: Promise<Record<string, LineageGlyphSummary>> } = { keys: [], done: Promise.resolve({}) };
    next.done = new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
      if (batch === next) batch = null;
      return unwrap(BlyggerApi.extLineageGlyphListSummaries({ client, query: { keys: JSON.stringify(next.keys) } })).then((got) => got.summaries);
    });
    batch = next;
  }
  batch.keys.push(key);
  const summary = batch.done.then(
    (summaries) => summaries[key],
    () => {
      cache.delete(key);
      return undefined;
    },
  );
  cache.set(key, { at: Date.now(), summary });
  return summary;
}
function useSummary(client: BlyggerClient, key: string, wanted: boolean) {
  const [summary, setSummary] = useState<LineageGlyphSummary>();
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    void summaryFor(client, key).then((got) => live && setSummary(got));
    return () => {
      live = false;
    };
  }, [client, key, wanted]);
  return summary;
}

/* ---------------- what each action does ---------------- */

const notHeld = { unavailable: 'Not held here — subscribe to its blyg to respond to, quote, fork or link it.' };

/** For the opening entry: the Studio's own handlers, where it offers them. */
function entryHandlers(context: EntryContext): Handlers {
  const { actions, entry } = context;
  const yours = entry.own ? 'This is your own post — edit it rather than respond to it.' : undefined;
  const handler = (run: (() => void) | undefined, unavailable: string) => (run ? { run } : { unavailable });
  return {
    stub: handler(actions.stub, yours ?? 'This post cannot be responded to.'),
    // Passages are chosen in the stub editor (0.31): quote opens it, like stub,
    // for the posts a passage can be quoted from (those that can be forked).
    quote: handler(actions.fork && actions.stub, yours ?? 'Only a blyg post you follow can be quoted.'),
    fork: handler(actions.fork, yours ?? 'This post cannot be forked.'),
    link: handler(actions.linkPost, 'A link to this post would not resolve.'),
    history: handler(actions.history, 'Your own versions are in the editor.'),
    open: handler(actions.open, 'It has no public page.'),
  };
}

/** For a node the sheet re-centred on: only what holding that node here allows. */
function nodeHandlers(node: LineageGlyphLineage['node'], context: EntryContext): Handlers {
  const { run, openDraft, navigate } = context;
  const url = node.url;
  const open = url ? { run: () => void window.open(url, '_blank', 'noreferrer') } : { unavailable: 'No public page is known for it.' };
  const id = node.id;
  const link = id ? { run: () => void run(() => openDraft({ content_md: `[[${id}]]\n\n`, kind: 'fragment' })) } : notHeld;
  if (node.held === 'imported' && node.sub && id) {
    const source = { subscription_id: node.sub, remote_id: id };
    const respond = { run: () => void run(() => openDraft({ mode: 'response', source })) };
    return {
      stub: respond,
      // Passages are chosen in the stub editor (0.31): quote opens it, like stub.
      quote: respond,
      fork: { run: () => void navigate({ to: '/fork', search: { id, sub: node.sub! } }) },
      link,
      history: { unavailable: "Its history opens from the post's own ⋯ sheet in the timeline." },
      open,
    };
  }
  if (node.held === 'own' && id) {
    const yours = { unavailable: 'This is your own post — edit it rather than respond to it.' };
    return { stub: yours, quote: yours, fork: yours, link, history: { unavailable: 'Your own versions are in the editor.' }, open };
  }
  return { stub: notHeld, quote: notHeld, fork: notHeld, link: notHeld, history: notHeld, open };
}

function openLineage(context: EntryContext) {
  const start = context.imported ? { id: context.id, sub: context.imported.subscriptionId } : { id: context.id };
  context.openSheet((close) => (
    <LineageSheet
      onClose={close}
      start={start}
      client={context.client}
      handlersFor={(node, isStart) => (isStart ? entryHandlers(context) : nodeHandlers(node, context))}
    />
  ));
}

/* ---------------- the slots ---------------- */

function Byline({ context }: { context: EntryContext }) {
  // A legacy feed has no item documents, so no lineage and no glyph.
  const summary = useSummary(context.client, context.entry.key, !context.entry.l0);
  if (context.entry.l0 || !summary) return null;
  return (
    <button
      type="button"
      className="glyph-btn"
      data-action="lineage"
      aria-label={glyphLabel(summary)}
      title="where this came from, what came from it, and what each action does"
      onClick={() => openLineage(context)}
    >
      <LineageGlyph summary={summary} />
      <span>{glyphCounts(summary)}</span>
    </button>
  );
}

export const extension: StudioExtension = {
  name: 'lineage-glyph',
  label: 'Lineage glyph',
  description:
    'A glyph in each reading byline for what a post draws on and what draws on it here, opening a hex view that shows what stub, quote, fork, link, history and open would each make.',
  entryByline: Byline,
  entryActions: (context) =>
    context.entry.l0 ? [] : [{ icon: '⬡', label: 'lineage', description: 'where it came from, and what each action makes', onSelect: () => openLineage(context) }],
};
