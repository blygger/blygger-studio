import { useEffect, useRef, useState } from 'react';
import type { SearchResponses } from '../../sdk/dist/browser.js';
import { BlyggerApi, unwrap } from '../../sdk/dist/browser.js';
import { client, queryClient, listViews, preloadView } from './data.ts';
import { Button, Failure, useSettings } from './components.tsx';
import { paletteTrigger, paletteInsert } from '../palette.ts';
import { setTextAt } from './caret.ts';
import './picker.css';
import { readCursorWindow } from './cursor-query.ts';
import { zSearchResponse } from '../../sdk/dist/schemas.js';
import { domainRevision } from './revision-query.ts';
import { toast } from './sheets.tsx';
import { locateSite, mintableLabel, placeholderAfterTyping, rewriteSite, stillMintable, type PlaceholderSite } from './placeholder-link.ts';

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
 *
 * **Placeholders** (speculative authoring, studio-only): closing `[[some
 * text]]` with a typed `]]`, or choosing *create placeholder* at the foot of
 * a link picker's list, creates an empty fragment draft for "some text" and
 * rewrites the brackets in place to `[[id | some text]]`, so the id is always
 * visible. One undo — ⌘Z/Ctrl+Z before anything else is typed, or the toast's
 * *undo* — restores `[[some text]]` and discards the draft if it is still
 * empty. The rules for what mints are in placeholder-link.ts.
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
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>();
  const [source, setSource] = useState<Source>(() => stored('blyg.picker.source', ['all', 'mine', 'imported'] as const, 'all'));
  const [sort, setSort] = useState<Sort>(() => stored('blyg.picker.sort', ['newest', 'oldest'] as const, 'newest'));
  const setting = useSettings()?.pickerTyping ?? 'auto';
  const focusMode: Focus = setting === 'auto' ? (touch() ? 'panel' : 'editor') : setting;
  const [sub, setSub] = useState('');
  const [subs, setSubs] = useState<{ id: string; title: string }[]>([]);
  const [panelQuery, setPanelQuery] = useState('');
  const [dismissed, setDismissed] = useState<string>();
  // The query whose search has answered: *create placeholder* waits for it, so
  // an Enter typed before the results arrive can never mint over a match.
  const [settled, setSettled] = useState<string>();
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
  // ── Placeholders ──
  const latest = useRef(text);
  latest.current = text;
  const previous = useRef(text);
  const undo = useRef<{ before: string; after: string; caret: number; id: string } | null>(null);
  const discardIfUntouched = async (id: string) => {
    try {
      const item = await unwrap(BlyggerApi.getItem({ client, path: { id } }));
      // Only a draft nobody has written in yet; anything else stays, listed under "not yet written".
      if (item.version === 0 && item.placeholder && !item.contentMd)
        await unwrap(BlyggerApi.deleteItem({ client, path: { id }, body: { expectedRevision: item.revision } }));
    } catch {
      /* left in place: it is a draft, listed with the others */
    }
  };
  const undoPlaceholder = () => {
    const step = undo.current;
    undo.current = null;
    if (!step || latest.current !== step.after) return false;
    previous.current = step.before;
    if (input.current) setTextAt(input.current, change, step.before, step.caret);
    else change(step.before);
    void discardIfUntouched(step.id);
    return true;
  };
  const mint = async (site: PlaceholderSite) => {
    let item: { id: string };
    try {
      item = await unwrap(BlyggerApi.createItem({ client, body: { mode: 'placeholder', label: site.label } }));
    } catch (failure) {
      toast(`Could not create a placeholder: ${failure instanceof Error ? failure.message : String(failure)}`);
      return;
    }
    // The text may have moved on while the item was made.
    const now = latest.current;
    const at = locateSite(now, site);
    if (at === null || !stillMintable(now, at)) {
      void discardIfUntouched(item.id);
      return;
    }
    const caretNow = input.current?.selectionStart ?? now.length;
    const next = rewriteSite(now, at, site, item.id, caretNow);
    previous.current = next.text;
    undo.current = { before: now, after: next.text, caret: caretNow, id: item.id };
    if (input.current) setTextAt(input.current, change, next.text, next.caret);
    else change(next.text);
    toast(`“${site.label}” is a placeholder, not yet written`, {
      duration: 6000,
      action: { label: 'undo', run: () => void undoPlaceholder() },
    });
  };
  useEffect(() => {
    const before = previous.current;
    previous.current = text;
    if (undo.current && text !== undo.current.after) undo.current = null;
    const site = placeholderAfterTyping(before, text, input.current?.selectionStart ?? -1);
    if (site) void mint(site);
  }, [text]);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'z') return;
      if (!undo.current || latest.current !== undo.current.after) return;
      event.preventDefault();
      undoPlaceholder();
    };
    element.addEventListener('keydown', onKey);
    return () => element.removeEventListener('keydown', onKey);
  });

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
    preloadView(listViews.subscriptions)
      .then(() => setSubs(listViews.subscriptions.toArray.filter((s) => s.kind === 'blyg').map((s) => ({ id: s.id, title: s.title || new URL(s.origin).host }))))
      .catch(() => {});
  }, [open, subs.length]);

  const loadPage = async (offset: number, controller: AbortController, query: string) => {
    if (controller.signal.aborted) return;
    setLoading(true);
    setError(undefined);
    try {
      const changes = await unwrap(BlyggerApi.getChanges({ client, signal: controller.signal }));
      const generation = { epoch: changes.epoch, revision: domainRevision(changes, ['items', 'reading', 'subscriptions']) };
      // A link may name an open placeholder of ours; a quote or a source may not.
      const filters = { q: query, source, sort, ...(source === 'imported' && sub ? { sub } : {}), ...(trigger?.form === 'link' ? { placeholders: 'include' as const } : {}) };
      const pageKey = ['search', 'pages', filters, generation];
      const rows = await readCursorWindow<Hit>({ queryClient, queryKey: pageKey, signal: controller.signal,
        window: { limit: offset + PAGE }, validate: page => { zSearchResponse.parse(page); }, read: (cursor, signal) => unwrap(BlyggerApi.search({ client, query: { ...filters, cursor, limit: PAGE }, signal })),
      });
      if (controller.signal.aborted || request.current !== controller) return;
      setHits(rows.slice(0, offset + PAGE));
      setSettled(query);
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
    setSelected(0);
    setSettled(undefined);
    setHits([]);
    setHasMore(false);
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
  }, [query, source, sort, sub, trigger?.form]);
  const loadMore = () => {
    const controller = request.current;
    if (controller && query !== undefined) void loadPage(hits.length, controller, query);
  };
  const backToEditor = (at: number) =>
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(at, at);
    });
  const pick = (hit: Hit) => {
    if (!trigger) return;
    const next = paletteInsert(text, caret, trigger, hit.id, hit.label);
    request.current?.abort();
    setHits([]);
    // Caret placed now, not on the next frame: see setTextAt.
    if (input.current) setTextAt(input.current, change, next.text, next.caret);
    else change(next.text);
  };
  // *create placeholder*: offered for a link whose query could name one, once
  // the search for it has answered. Last in the keyboard order, after every hit.
  const createLabel = open && trigger?.form === 'link' && query !== undefined && settled === query ? mintableLabel(query) : null;
  const options = hits.length + (createLabel ? 1 : 0);
  const create = () => {
    if (!trigger || !createLabel) return;
    request.current?.abort();
    setHits([]);
    setDismissed(triggerKey);
    // In editor mode the typed `[[some text` is replaced; in panel mode the bare `[[` is.
    void mint({ start: trigger.start, end: caret, original: text.slice(trigger.start, caret), label: createLabel });
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
    if (!options) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected((i) => Math.min(i + 1, options - 1));
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected((i) => Math.max(i - 1, 0));
    }
    if (event.key === 'Enter' && hits[selected]) {
      event.preventDefault();
      pick(hits[selected]);
    } else if (event.key === 'Enter' && createLabel && selected === hits.length) {
      event.preventDefault();
      create();
    }
  };
  useEffect(() => {
    const element = input.current;
    if (!element || !open) return;
    element.addEventListener('keydown', navigate);
    return () => element.removeEventListener('keydown', navigate);
  });
  useEffect(() => {
    document.querySelector('.picker .sel')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (!open || !trigger) return null;
  const head = {
    link: { name: 'link', code: '[[…]]', sub: 'cites without responding' },
    transclude: { name: 'quote', code: '![[…]]', sub: 'transcludes the item into this thread' },
    source: { name: 'source', code: '![[…]]', sub: 'feeds the item to the generator; its author is told' },
  }[trigger.form];
  return (
    <aside className={full ? 'picker picker-full' : 'picker'} role="complementary" aria-label={`${head.name} picker`}>
      <header className="picker-head">
        <div>
          <strong>{head.name}</strong> <code>{head.code}</code>
          <div className="picker-sub">{head.sub}</div>
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
        {loading && !hits.length ? 'searching…' : `${hits.length.toLocaleString()}${hasMore ? '+' : ''} item${hits.length === 1 && !hasMore ? '' : 's'}`}
      </div>
      <ul role="listbox" aria-label="items" className="picker-list">
        {hits.map((hit, i) => (
          <li
            role="option"
            aria-selected={i === selected}
            className={i === selected ? 'sel' : ''}
            key={JSON.stringify([hit.source, hit.subscriptionId, hit.id])}
            onMouseEnter={() => setSelected(i)}
            onMouseDown={(event) => {
              event.preventDefault();
              pick(hit);
            }}
          >
            <span className="picker-excerpt">{hit.placeholder ? hit.label : hit.excerpt}</span>
            <span className="picker-meta">
              {hit.source === 'mine' ? <span className="picker-mine">mine</span> : <span>{hit.sourceTitle}</span>} · {hit.kind} · {ago(hit.updated)} ·{' '}
              {hit.placeholder ? <span className="picker-placeholder">not yet written</span> : `v${hit.version}`}
            </span>
          </li>
        ))}
      </ul>
      {createLabel ? (
        <button
          type="button"
          id="picker-create-placeholder"
          className={selected === hits.length ? 'picker-create sel' : 'picker-create'}
          aria-describedby="picker-create-note"
          onMouseEnter={() => setSelected(hits.length)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={create}
        >
          <span className="picker-excerpt">Create placeholder “{createLabel}”</span>
          <span className="picker-meta" id="picker-create-note">
            a new draft to write later · links to it publish as plain text until then
          </span>
        </button>
      ) : null}
      {error ? (
        <Button className="btn btn-ghost btn-mini" disabled={loading} onMouseDown={(event) => event.preventDefault()} onClick={loadMore}>
          retry search
        </Button>
      ) : null}
      {hasMore ? (
        <Button className="btn btn-ghost btn-mini" disabled={loading} onMouseDown={(event) => event.preventDefault()} onClick={loadMore}>
          load more
        </Button>
      ) : null}
      <footer className="picker-foot">
        <span className="hint">↑↓ to move · Enter to insert · Esc to close</span>
      </footer>
    </aside>
  );
}
