import { useEffect, useRef, useState } from 'react';
import type { SearchResponses } from '../../sdk/dist/browser.js';
import { BlyggerApi, unwrap } from '../../sdk/dist/browser.js';
import { client } from './data.ts';
import { Button, Failure, useSettings } from './components.tsx';
import { paletteTrigger, paletteInsert } from '../palette.ts';
import { setTextAt } from './caret.ts';
import './picker.css';

/**
 * The `[[` / `![[` picker (0.29). Typing either bracket form opens a panel at
 * the right (docked at the bottom on a phone) that searches everything the
 * form can name: own published items and imported blyg items, by every word
 * anywhere in their text, filtered by source and sorted newest or oldest first.
 *
 * Where the typing goes is the `picker_typing` setting (Settings → writing):
 * in `editor` mode the query is whatever follows the brackets and the keyboard
 * stays in the textarea, as before 0.29; in `panel` mode focus moves to the
 * panel's own search box. `auto`, the default, is the editor with a mouse and
 * the panel on a touch screen (Venkat, session 36, after trying both). In
 * panel mode on a phone the picker takes the whole screen: there is nothing
 * to type in the editor meanwhile, and a half-height dock under the keyboard
 * was the awkward part. Both modes share every other part.
 */
type Hit = SearchResponses[200]['items'][number];
type Source = 'all' | 'mine' | 'imported';
type Sort = 'newest' | 'oldest';
type Focus = 'editor' | 'panel';
// Touch without hover, the same test as the reading list's swipe hint (#36).
const touch = () => matchMedia('(hover: none) and (pointer: coarse)').matches;
const narrow = () => matchMedia('(max-width: 640px)').matches;
const PAGE = 20;

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return allowed.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private window or blocked storage: the choice lasts this page only */
  }
}

function ago(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days)) return '';
  if (days < 1) return 'today';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function BracketPicker({
  input,
  text,
  change,
  allowTransclude = false,
}: {
  input: React.RefObject<HTMLTextAreaElement | null>;
  text: string;
  change: (text: string) => void;
  allowTransclude?: boolean;
}) {
  const [hits, setHits] = useState<Hit[]>([]);
  const [selected, setSelected] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>();
  const [source, setSource] = useState<Source>(() => stored('blyg.picker.source', ['all', 'mine', 'imported'] as const, 'all'));
  const [sort, setSort] = useState<Sort>(() => stored('blyg.picker.sort', ['newest', 'oldest'] as const, 'newest'));
  const setting = useSettings()?.picker_typing ?? 'auto';
  const focusMode: Focus = setting === 'auto' ? (touch() ? 'panel' : 'editor') : setting;
  const [sub, setSub] = useState('');
  const [subs, setSubs] = useState<{ id: string; title: string }[]>([]);
  const [panelQuery, setPanelQuery] = useState('');
  const [dismissed, setDismissed] = useState<string>();
  const request = useRef<AbortController | undefined>(undefined);
  const search = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(text.length);
  useEffect(() => {
    const element = input.current;
    const update = () => setCaret(element?.selectionStart ?? text.length);
    element?.addEventListener('selectionchange', update);
    element?.addEventListener('keyup', update);
    element?.addEventListener('click', update);
    update();
    return () => {
      element?.removeEventListener('selectionchange', update);
      element?.removeEventListener('keyup', update);
      element?.removeEventListener('click', update);
    };
  }, [input, text]);
  const trigger = paletteTrigger(text, caret, allowTransclude);
  // One trigger is one bracket being typed; Escape dismisses that one only.
  const triggerKey = trigger ? `${trigger.form}:${trigger.start}` : undefined;
  const open = !!trigger && dismissed !== triggerKey;
  useEffect(() => setPanelQuery(trigger?.query ?? ''), [trigger?.query]);
  const query = !open ? undefined : focusMode === 'panel' ? panelQuery : trigger.query;

  // On a phone the panel docks over the bottom half: bring the text being
  // typed into the half that stays visible.
  const full = open && focusMode === 'panel' && narrow();
  useEffect(() => {
    if (open && !full && narrow()) input.current?.scrollIntoView({ block: 'start' });
  }, [open, triggerKey, full]);
  // Panel mode: the search box takes the keyboard when the panel opens.
  useEffect(() => {
    if (open && focusMode === 'panel') requestAnimationFrame(() => search.current?.focus());
  }, [open, triggerKey, focusMode]);
  useEffect(() => {
    if (!open || subs.length) return;
    unwrap(BlyggerApi.listSubscriptions({ client, query: { limit: 100 } }))
      .then((r) => setSubs(r.items.filter((s) => s.kind === 'blyg').map((s) => ({ id: s.id, title: s.title || new URL(s.origin).host }))))
      .catch(() => {});
  }, [open, subs.length]);

  const loadPage = async (offset: number, controller: AbortController, query: string) => {
    if (controller.signal.aborted) return;
    setLoading(true);
    setError(undefined);
    try {
      const result = await unwrap(
        BlyggerApi.search({
          client,
          query: { q: query, offset, limit: PAGE, source, sort, ...(source === 'imported' && sub ? { sub } : {}) },
          signal: controller.signal,
        }),
      );
      if (controller.signal.aborted || request.current !== controller) return;
      setHits((current) => (offset === 0 ? result.items : [...current, ...result.items.filter((item) => !current.some((hit) => hit.id === item.id))]));
      setTotal(result.total);
    } catch (failure) {
      if (!controller.signal.aborted && request.current === controller) setError(failure);
    } finally {
      if (request.current === controller) setLoading(false);
    }
  };
  useEffect(() => {
    setSelected(0);
    setHits([]);
    setTotal(0);
    setError(undefined);
    setLoading(false);
    if (query === undefined) return;
    const controller = new AbortController();
    request.current = controller;
    const timer = setTimeout(() => void loadPage(0, controller, query), 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
      if (request.current === controller) request.current = undefined;
    };
  }, [query, source, sort, sub]);
  const loadMore = () => {
    const controller = request.current;
    if (controller && query !== undefined) void loadPage(hits.length, controller, query);
  };
  const backToEditor = (at: number) =>
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(at, at);
    });
  const pick = (id: string) => {
    if (!trigger) return;
    const next = paletteInsert(text, caret, trigger, id);
    request.current?.abort();
    setHits([]);
    // Caret placed now, not on the next frame: see setTextAt.
    if (input.current) setTextAt(input.current, change, next.text, next.caret);
    else change(next.text);
  };
  const dismiss = () => {
    request.current?.abort();
    setHits([]);
    setError(undefined);
    setDismissed(triggerKey);
    backToEditor(caret);
  };
  // In editor mode a click on a filter must not strand the keyboard in the panel.
  const afterControl = () => {
    if (focusMode === 'editor') backToEditor(caret);
  };
  const navigate = (event: KeyboardEvent | React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      dismiss();
      return;
    }
    if (!hits.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected((i) => Math.min(i + 1, hits.length - 1));
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected((i) => Math.max(i - 1, 0));
    }
    if (event.key === 'Enter' && hits[selected]) {
      event.preventDefault();
      pick(hits[selected].id);
    }
  };
  useEffect(() => {
    const element = input.current;
    if (!element || !open) return;
    element.addEventListener('keydown', navigate);
    return () => element.removeEventListener('keydown', navigate);
  });
  useEffect(() => {
    document.querySelector('.picker li.sel')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (!open || !trigger) return null;
  const link = trigger.form === 'link';
  return (
    <aside className={full ? 'picker picker-full' : 'picker'} role="complementary" aria-label={link ? 'link picker' : 'quote picker'}>
      <header className="picker-head">
        <div>
          <strong>{link ? 'link' : 'quote'}</strong> <code>{link ? '[[…]]' : '![[…]]'}</code>
          <div className="picker-sub">{link ? 'cites without responding' : 'transcludes the item into this thread'}</div>
        </div>
        <Button className="btn btn-ghost btn-mini" aria-label="close picker" onMouseDown={(e) => e.preventDefault()} onClick={dismiss}>
          ✕
        </Button>
      </header>
      {focusMode === 'panel' ? (
        <input
          ref={search}
          id="picker-search"
          type="search"
          className="picker-search"
          placeholder="search every word"
          aria-label="search items"
          value={panelQuery}
          onChange={(e) => setPanelQuery(e.target.value)}
          onKeyDown={navigate}
        />
      ) : (
        <p className="picker-query">
          {trigger.query ? (
            <>
              <q>{trigger.query}</q> · keep typing to narrow
            </>
          ) : (
            <>type after the brackets to search</>
          )}
        </p>
      )}
      <div className="picker-filters">
        <div role="radiogroup" aria-label="source" className="picker-seg">
          {(['all', 'mine', 'imported'] as const).map((value) => (
            <label key={value}>
              <input
                type="radio"
                name="picker-source"
                value={value}
                checked={source === value}
                onChange={() => {
                  setSource(value);
                  store('blyg.picker.source', value);
                  afterControl();
                }}
              />
              <span>{value === 'all' ? 'both' : value}</span>
            </label>
          ))}
        </div>
        <select
          aria-label="sort"
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as Sort);
            store('blyg.picker.sort', e.target.value);
            afterControl();
          }}
        >
          <option value="newest">newest first</option>
          <option value="oldest">oldest first</option>
        </select>
        {source === 'imported' && subs.length ? (
          <select
            aria-label="subscription"
            value={sub}
            onChange={(e) => {
              setSub(e.target.value);
              afterControl();
            }}
          >
            <option value="">every subscription</option>
            {subs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <Failure error={error} />
      <div className="picker-count" aria-live="polite">
        {loading && !hits.length ? 'searching…' : `${total.toLocaleString()} item${total === 1 ? '' : 's'}`}
      </div>
      <ul role="listbox" aria-label="items" className="picker-list">
        {hits.map((hit, i) => (
          <li
            role="option"
            aria-selected={i === selected}
            className={i === selected ? 'sel' : ''}
            key={hit.id}
            onMouseEnter={() => setSelected(i)}
            onMouseDown={(event) => {
              event.preventDefault();
              pick(hit.id);
            }}
          >
            <span className="picker-excerpt">{hit.excerpt}</span>
            <span className="picker-meta">
              {hit.source === 'mine' ? <span className="picker-mine">mine</span> : <span>{hit.source_title}</span>} · {hit.kind} · {ago(hit.updated)} · v{hit.version}
            </span>
          </li>
        ))}
      </ul>
      {error ? (
        <Button className="btn btn-ghost btn-mini" disabled={loading} onMouseDown={(event) => event.preventDefault()} onClick={loadMore}>
          retry search
        </Button>
      ) : null}
      {hits.length < total ? (
        <Button className="btn btn-ghost btn-mini" disabled={loading} onMouseDown={(event) => event.preventDefault()} onClick={loadMore}>
          load more ({hits.length} of {total})
        </Button>
      ) : null}
      <footer className="picker-foot">
        <span className="hint">↑↓ to move · Enter to insert · Esc to close</span>
      </footer>
    </aside>
  );
}
