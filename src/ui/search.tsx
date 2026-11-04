/**
 * Search, shared by the `[[` / `![[` picker, the reading page and the compose
 * page (docs/search.md). One route (`GET /search`), one paged query, one hit
 * shape: the three surfaces differ only in their filters and in where a hit
 * goes, so their scopes cannot drift apart.
 *
 * The query lives in the page URL (`?q=`) on the reading and compose pages, so
 * back returns to the results and a search can be bookmarked.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { SearchResponses } from '../../sdk/dist/browser.js';
import { BlyggerApi, unwrap } from '../../sdk/dist/browser.js';
import { zSearchResponse } from '../../sdk/dist/schemas.js';
import { client, queryClient } from './data.ts';
import { Button, Failure } from './components.tsx';
import { readCursorWindow } from './cursor-query.ts';
import { domainRevision } from './revision-query.ts';
import './search.css';

export type Hit = SearchResponses[200]['items'][number];
export type SearchFilters = {
  q: string;
  source?: 'all' | 'mine' | 'imported';
  sort?: 'newest' | 'oldest';
  sub?: string;
  include?: 'drafts';
};
const PAGE = 20;
/** Pages search from this many characters; the picker searches from none. */
export const MIN_QUERY = 2;

export function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return allowed.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}
export function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private window or blocked storage: the choice lasts this page only */
  }
}

export function ago(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days)) return '';
  if (days < 1) return 'today';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * The paged search. `undefined` filters mean closed: nothing is fetched and
 * the hits are empty. A change of filters starts over after `delay` ms.
 */
export function useSearch(filters: SearchFilters | undefined, delay = 150) {
  const [hits, setHits] = useState<Hit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>();
  const request = useRef<AbortController | undefined>(undefined);
  const key = filters ? JSON.stringify(filters) : undefined;

  const loadPage = async (offset: number, controller: AbortController, f: SearchFilters) => {
    if (controller.signal.aborted) return;
    setLoading(true);
    setError(undefined);
    try {
      const changes = await unwrap(BlyggerApi.getChanges({ client, signal: controller.signal }));
      const generation = { epoch: changes.epoch, revision: domainRevision(changes, ['items', 'reading', 'subscriptions']) };
      const pageKey = ['search', 'pages', f, generation];
      const rows = await readCursorWindow<Hit>({ queryClient, queryKey: pageKey, signal: controller.signal,
        window: { limit: offset + PAGE }, validate: page => { zSearchResponse.parse(page); }, read: (cursor, signal) => unwrap(BlyggerApi.search({ client, query: { ...f, cursor, limit: PAGE }, signal })),
      });
      if (controller.signal.aborted || request.current !== controller) return;
      setHits(rows.slice(0, offset + PAGE));
      const cached = queryClient.getQueryData<{ pages: { rows: readonly Hit[]; nextCursor: string | null }[] }>(pageKey);
      const acquired = cached?.pages.reduce((sum, page) => sum + page.rows.length, 0) ?? rows.length;
      setHasMore(acquired > offset + PAGE || cached?.pages.at(-1)?.nextCursor != null);
    } catch (failure) {
      if (!controller.signal.aborted && request.current === controller) setError(failure);
    } finally {
      if (request.current === controller) setLoading(false);
    }
  };
  useEffect(() => {
    setHits([]);
    setHasMore(false);
    setError(undefined);
    setLoading(false);
    if (!filters) return;
    const controller = new AbortController();
    request.current = controller;
    const timer = setTimeout(() => void loadPage(0, controller, filters), delay);
    return () => {
      clearTimeout(timer);
      controller.abort();
      if (request.current === controller) request.current = undefined;
    };
  }, [key]);
  const loadMore = () => {
    const controller = request.current;
    if (controller && filters) void loadPage(hits.length, controller, filters);
  };
  /** Stop the search in flight and clear the hits (the picker, on pick). */
  const cancel = () => {
    request.current?.abort();
    setHits([]);
    setError(undefined);
  };
  return { hits, hasMore, loading, error, loadMore, cancel };
}

/** The excerpt with each searched word marked, case-insensitively. */
export function Marked({ text, q }: { text: string; q: string }) {
  const words = q.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!words.length) return <>{text}</>;
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const parts = text.split(new RegExp(`(${escaped.join('|')})`, 'gi'));
  return <>{parts.map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}</>;
}

export function hitMeta(hit: Hit): ReactNode {
  return (
    <>
      {hit.source === 'mine' ? <span className="picker-mine">mine</span> : <span>{hit.sourceTitle}</span>}
      {hit.draft ? <> · <span className="search-draft">{hit.version ? 'unpublished changes' : 'draft'}</span></> : null}
      {' '}· {hit.kind} · {ago(hit.updated)}{hit.version ? ` · v${hit.version}` : ''}
    </>
  );
}

/**
 * A page's search box. Typing updates the URL after a pause (replacing the
 * history entry, so back leaves the search rather than undoing letters);
 * Escape clears; `/` anywhere else on the page focuses it.
 */
export function SearchBox({
  value,
  onChange,
  label,
  placeholder = 'search every word',
}: {
  value: string;
  onChange: (q: string) => void;
  label: string;
  placeholder?: string;
}) {
  const [text, setText] = useState(value);
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (text === value) return;
    const timer = setTimeout(() => onChange(text), 250);
    return () => clearTimeout(timer);
  }, [text]);
  useEffect(() => {
    const focus = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      box.current?.focus();
    };
    document.addEventListener('keydown', focus);
    return () => document.removeEventListener('keydown', focus);
  }, []);
  return (
    <input
      ref={box}
      type="search"
      className="page-search"
      placeholder={placeholder}
      aria-label={label}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setText('');
          onChange('');
        }
        if (event.key === 'Enter') onChange(text);
      }}
    />
  );
}

/**
 * A page's results. Own items open in the editor (`ownOpens: 'editor'`, the
 * compose page) or in the reader; imported items always open in the reader.
 */
export function SearchResults({ filters, ownOpens }: { filters: SearchFilters; ownOpens: 'editor' | 'reader' }) {
  const ready = filters.q.trim().length >= MIN_QUERY;
  const { hits, hasMore, loading, error, loadMore } = useSearch(ready ? filters : undefined, 0);
  if (!ready) return <p className="search-count">Type at least {MIN_QUERY} characters.</p>;
  return (
    <section className="search-results" aria-label="search results">
      <Failure error={error} />
      <p className="search-count" aria-live="polite">
        {loading && !hits.length ? 'searching…' : `${hits.length.toLocaleString()}${hasMore ? '+' : ''} item${hits.length === 1 && !hasMore ? '' : 's'}`}
      </p>
      <ul className="search-list">
        {hits.map((hit) => {
          const body = (
            <>
              <span className="search-excerpt"><Marked text={hit.excerpt} q={filters.q} /></span>
              <span className="search-meta">{hitMeta(hit)}</span>
            </>
          );
          return (
            <li key={JSON.stringify([hit.source, hit.subscriptionId, hit.id])}>
              {hit.source === 'mine' && ownOpens === 'editor' ? (
                <Link to="/edit/$id" params={{ id: hit.id }}>{body}</Link>
              ) : (
                <Link to="/reading/$sub/$id" params={{ sub: hit.source === 'mine' ? '~own' : hit.subscriptionId ?? '', id: hit.id }}>{body}</Link>
              )}
            </li>
          );
        })}
      </ul>
      {error ? <Button className="btn btn-ghost btn-mini" disabled={loading} onClick={loadMore}>retry search</Button> : null}
      {hasMore ? <Button className="btn btn-ghost btn-mini" disabled={loading} onClick={loadMore}>load more</Button> : null}
    </section>
  );
}
