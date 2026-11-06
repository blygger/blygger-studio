/*
 * word-count: words at the end of each reading entry's byline and the full
 * editor's status line, and for an item whose outline links form a clean tree
 * (a contents thread), the words in the whole document under it. Our own
 * entries are counted by the extension's owner read, one request per page;
 * imported ones from the HTML the reading view already holds, with no roll-up.
 * The editor re-reads after each autosave, so it and the byline count alike.
 */
import { useEffect, useState } from 'react';
import type { StudioExtension } from '../../../src/ui/extension-api.ts';
import { BlyggerApi, unwrap } from '../../../src/ui/extension-api.ts';
import type { BlyggerClient, WordCount } from '../../../sdk/dist/browser.js';
import { countWords, type Count } from '../count.ts';

const FRESH_MS = 30_000;
const BATCH = 50;
const cache = new Map<string, { at: number; count: Promise<WordCount | undefined> }>();
let batch: { keys: string[]; done: Promise<Record<string, WordCount>> } | null = null;

/** The count for one own entry. Bylines mounting in the same tick share one GET. */
function countFor(client: BlyggerClient, key: string) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.count;
  if (!batch || batch.keys.length >= BATCH) {
    const next: { keys: string[]; done: Promise<Record<string, WordCount>> } = { keys: [], done: Promise.resolve({}) };
    next.done = new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
      if (batch === next) batch = null;
      return unwrap(BlyggerApi.extWordCountListCounts({ client, query: { keys: JSON.stringify(next.keys) } })).then((got) => got.counts);
    });
    batch = next;
  }
  batch.keys.push(key);
  const count = batch.done.then(
    (counts) => counts[key],
    () => {
      cache.delete(key);
      return undefined;
    },
  );
  cache.set(key, { at: Date.now(), count });
  return count;
}

/** Pass `revision` to re-read past the cache whenever it moves; a failed re-read keeps the last count. */
function useOwnCount(client: BlyggerClient, key: string, wanted: boolean, revision?: number) {
  const [count, setCount] = useState<WordCount>();
  useEffect(() => {
    if (!wanted) return;
    if (revision !== undefined) cache.delete(key);
    let live = true;
    void countFor(client, key).then((got) => live && setCount((last) => got ?? last));
    return () => {
      live = false;
    };
  }, [client, key, wanted, revision]);
  return count;
}

const number = (n: number) => n.toLocaleString();

/** "2,140 words", "300 characters", "2,140 words, 300 characters"; "" for nothing. */
export function formatCount({ words, cjk }: Count) {
  return [words ? `${number(words)} ${words === 1 ? 'word' : 'words'}` : '', cjk ? `${number(cjk)} ${cjk === 1 ? 'character' : 'characters'}` : ''].filter(Boolean).join(', ');
}

const NO_TOTAL: Record<NonNullable<WordCountSide['reason']>, string> = {
  cycle: 'its outline links lead back to an item above them',
  repeated: 'its outline lists an item more than once',
  unavailable: 'its outline links to something that is not one of your items',
  'too-large': 'its outline tree is too large to count',
};

type WordCountSide = NonNullable<WordCount['published']>;
const same = (a: Count | null | undefined, b: Count | null | undefined) => !!a && !!b && a.words === b.words && a.cjk === b.cjk;
/** A side's roll-up, when its outline has anything under the item. */
const documentOf = (side: WordCountSide | null | undefined) => (side?.document && side.document.items > 1 ? side.document : null);

/** One line of the tooltip: a side's own count and its roll-up, or why it has none. */
function describe(name: string, side: WordCountSide) {
  const document = documentOf(side);
  const tree = document ? `; ${formatCount(document)} across the ${number(document.items)} items of its outline` : side.reason ? `; no document total: ${NO_TOTAL[side.reason]}` : '';
  return `${name}: ${formatCount(side) || 'nothing'}${tree}.`;
}

/** Own entries: the published count, and the draft's where it is ahead or behind. */
function OwnCount({ count }: { count: WordCount }) {
  const { published, draft } = count;
  const pubDoc = documentOf(published);
  const draftDoc = documentOf(draft);
  const title = [published ? describe('Published', published) : 'Never published.', same(published, draft) && same(pubDoc, draftDoc) && published?.reason === draft.reason ? '' : describe('Draft', draft)].filter(Boolean).join('\n');
  const item = published ? formatCount(published) : '';
  const draftItem = same(published, draft) ? '' : formatCount(draft);
  if (!item && !draftItem) return null;
  return (
    <span data-extension="word-count" title={title}>
      {item ? `· ${item}` : null}
      {draftItem ? <span data-word-count="draft">{item ? ` (draft ${draftItem})` : `· draft ${draftItem}`}</span> : null}
      {pubDoc || draftDoc ? (
        <>
          {' · '}
          {pubDoc ? `${formatCount(pubDoc)} in document` : 'document'}
          {draftDoc && !same(pubDoc, draftDoc) ? <span data-word-count="draft-document">{pubDoc ? ` (draft ${formatCount(draftDoc)})` : ` in draft: ${formatCount(draftDoc)}`}</span> : null}
        </>
      ) : null}
    </span>
  );
}

export const extension: StudioExtension = {
  name: 'word-count',
  label: 'Word count',
  description: 'Shows each entry’s word count at the end of its byline and in the full editor, published and in draft, and for a thread whose list of links forms an outline, such as a table of contents, the words in the whole document under it.',
  entryByline: ({ context }) => {
    const { entry } = context;
    const own = entry.source === 'own' && !entry.withdrawn;
    const served = useOwnCount(context.client, entry.key, own);
    if (entry.withdrawn) return null;
    if (own) return served ? <OwnCount count={served} /> : null;
    const label = formatCount(countWords(entry.contentHtml));
    return label ? (
      <span data-extension="word-count" title={label}>
        · {label}
      </span>
    ) : null;
  },
  editorStatus: ({ context }) => {
    const { item } = context;
    const own = item.status !== 'withdrawn';
    const served = useOwnCount(context.client, `own:${item.id}`, own, item.revision);
    return own && served ? <OwnCount count={served} /> : null;
  },
};
