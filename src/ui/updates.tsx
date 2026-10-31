// The updates tab: published threads whose quotes have fallen behind their
// sources, stalest first. It replaced a warning banner at the top of compose
// (0.23.0), which read as a to-do list and invited a republish per alert: a
// flood of trivial versions. The norm this page sets instead is batching:
// refresh an item when it has drifted far enough, and in order of drift. The
// order is the server's (`behind`, the versions the stale quotes have missed),
// so a future maintenance agent and this page read the same queue.
import { useEffect, useState } from 'react';
import { useLiveQuery } from '@tanstack/react-db';
import { Link } from '@tanstack/react-router';
import type { ThreadFreshness } from '../../sdk/dist/browser.js';
import { BlyggerApi, unwrap } from '../../sdk/dist/browser.js';
import { renderMarkdown } from '../markdown.ts';
import { extractDirectives } from '../directives.ts';
import { previewFromHtml } from '../preview.ts';
import { client, items } from './data.ts';
import { Failure, useChrome } from './components.tsx';

export const UPDATES_NOTE =
  'Items with stale transcludes will appear here, in descending order of staleness. The recommended maintenance pattern is to periodically do batched version updates for individual items as they get too stale. This work is planned for future agentic maintenance.';

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** "3 versions behind · 2 stale quotes · 1 needs editing", leaving out zeros. */
export function stalenessLine(t: Pick<ThreadFreshness, 'behind' | 'stale' | 'blocking'>): string {
  return [
    t.behind ? `${plural(t.behind, 'version')} behind` : '',
    t.stale ? plural(t.stale, 'stale quote') : '',
    t.blocking ? `${t.blocking} ${t.blocking === 1 ? 'needs' : 'need'} editing` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function UpdatesPage() {
  useChrome({ framed: false });
  const rows =
    useLiveQuery({ query: (q) => q.from({ item: items }) }).data ?? [];
  const [queue, setQueue] = useState<ThreadFreshness[]>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    let live = true;
    unwrap(BlyggerApi.listStaleThreads({ client }))
      .then((r) => live && setQueue(r.items))
      .catch((e) => live && setError(e));
    return () => {
      live = false;
    };
  }, []);
  const label = (id: string) => {
    const row = rows.find((r) => r.id === id);
    if (!row) return id.slice(0, 8);
    const p = previewFromHtml(
      renderMarkdown(extractDirectives(row.contentMd).withoutDirectives),
    );
    return p.title || p.body || id.slice(0, 8);
  };
  return (
    <>
      <h2 className="view-h">updates</h2>
      <p className="view-sub updates-note">{UPDATES_NOTE}</p>
      <Failure error={error} />
      {queue === undefined && !error ? (
        <p className="h-hint">Checking quotes…</p>
      ) : queue?.length ? (
        <ul className="nav-list updates-list">
          {queue.map((t) => (
            <li key={t.id} data-behind={t.behind}>
              <Link to="/edit/$id" params={{ id: t.id }} hash="snapshots">
                <span className="ml">
                  {label(t.id)}
                  <span className="md">{stalenessLine(t)}</span>
                </span>
                <span className="chev" aria-hidden="true">
                  ›
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : queue ? (
        <p className="h-hint">Nothing is stale right now.</p>
      ) : null}
    </>
  );
}
