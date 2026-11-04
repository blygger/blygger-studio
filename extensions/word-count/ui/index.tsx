/*
 * word-count: words at the end of each reading entry's byline, and for an item
 * whose outline links form a clean tree (a contents thread), the words in the
 * whole document under it. Our own entries are counted by the extension's
 * owner read, one request per page; imported ones from the HTML the reading
 * view already holds, with no roll-up.
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

function useOwnCount(client: BlyggerClient, key: string, wanted: boolean) {
  const [count, setCount] = useState<WordCount>();
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    void countFor(client, key).then((got) => live && setCount(got));
    return () => {
      live = false;
    };
  }, [client, key, wanted]);
  return count;
}

const number = (n: number) => n.toLocaleString();

/** "2,140 words", "300 characters", "2,140 words, 300 characters"; "" for nothing. */
export function formatCount({ words, cjk }: Count) {
  return [words ? `${number(words)} ${words === 1 ? 'word' : 'words'}` : '', cjk ? `${number(cjk)} ${cjk === 1 ? 'character' : 'characters'}` : ''].filter(Boolean).join(', ');
}

const NO_TOTAL: Record<NonNullable<WordCount['reason']>, string> = {
  cycle: 'its outline links lead back to an item above them',
  repeated: 'its outline lists an item more than once',
  unavailable: 'its outline links to something that is not one of your published items',
  'too-large': 'its outline tree is too large to count',
};

export const extension: StudioExtension = {
  name: 'word-count',
  label: 'Word count',
  description: 'Shows each entry’s word count at the end of its byline, and for a thread whose list of links forms an outline, such as a table of contents, the words in the whole document under it.',
  entryByline: ({ context }) => {
    const { entry } = context;
    const own = entry.source === 'own' && !entry.withdrawn;
    const served = useOwnCount(context.client, entry.key, own);
    if (entry.withdrawn) return null;
    const count = own ? served : countWords(entry.contentHtml);
    const label = count ? formatCount(count) : '';
    if (!count || !label) return null;
    const document = served?.document && served.document.items > 1 ? served.document : null;
    const title = document
      ? `${label} in this item; ${formatCount(document)} across the ${number(document.items)} items of its outline`
      : served?.reason
        ? `${label}. No document total: ${NO_TOTAL[served.reason]}.`
        : label;
    return (
      <span data-extension="word-count" title={title}>
        · {label}
        {document ? <> · {formatCount(document)} in document</> : null}
      </span>
    );
  },
};
