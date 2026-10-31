/*
 * Reading — NetNewsWire on a phone (PWA redesign, phase 2B).
 *
 *   /reading                 the sources list: all, my blyg, hoppers, subscriptions
 *   /reading?sub=X&offset=N  one source's timeline (the pre-redesign search params)
 *   /reading?hopper=H        a hopper's members as a timeline
 *
 * Each subscription has an inspector sheet (ⓘ, or swipe its row left), which
 * replaced the /subs page as the place a feed is managed. Every action an
 * entry had before the redesign is still here — the bar holds the ones used
 * most, the ⋯ sheet the rest — and the swipes are second ways to the same
 * handlers, never the only way. Choosing a passage to quote happens in the
 * stub editor (session 37), not here.
 */
import { readingPage } from '../paging.ts';
import { linkSource } from '../grammar.ts';
import { linkLabel } from '../link-label.ts';
import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from '@tanstack/react-db';
import { Link, useNavigate } from '@tanstack/react-router';
import type {
  CreateItemData,
  Hopper,
  ImportedItem,
  SignalRow,
  ListReadingResponses,
  Subscription,
} from '../../sdk/dist/browser.js';
import { BlyggerApi, unwrap } from '../../sdk/dist/browser.js';
import type { Lens, Reading } from './data.ts';
import { LENSES, lensKind, readingKey } from './data.ts';
import {
  reading,
  readingView,
  subscriptions,
  hoppers,
  signals,
  client,
  changed,
  queryClient,
  hopperDetail,
  hopperPreview,
  markReading,
  saveReadState,
} from './data.ts';
import { needsRead, readStatus, readWrites } from './read-state.ts';
import {
  Button,
  Failure,
  mount,
  useChrome,
  useSettings,
  SourceLink,
} from './components.tsx';
import { Sheet, confirm, menu, prompt, toast } from './sheets.tsx';
import { displayUrl, sourceTitleAndUrl } from '../importer/util.ts';
import { ReaderBody, TrailBar, ownOrigin, useEndTrail, useSubscriptionRows } from './reader-links.tsx';
import { currentTrail, visit } from './browse.ts';
import { formatDateIn } from '../dates.ts';
import { AddFeedForm } from './catalog.tsx';
import { OpmlImportSheet } from './opml-import.tsx';
import { diffText, type DiffOp } from '../word-diff.ts';
import { useSwipe } from './swipe.ts';
import type { EntryContext, StudioExtension } from './extension-api.ts';
import { EntryBylineSlot, EntrySheetSlot, entryActionRows, enabledExtensions, type OpenSheet } from './extensions.tsx';
import { compiledExtensions } from '../../build/extensions.ui.ts';
import { More, ThumbDown, ThumbUp } from './icons.tsx';
import './reading.css';

import type { CachedResponse } from './revision-query.ts';

const PAGE = 25;

/* ---------------- small helpers ---------------- */

/** The cached page metadata (counts, total) for one reading view. */
function readingMeta(sub: string, offset: number) {
  return queryClient
    .getQueriesData<CachedResponse<ListReadingResponses[200]>>({ queryKey: ['reading', sub] })
    .map(([, value]) => value?.data)
    .find((value) => value?.offset === offset);
}
/** A poll time, to the minute, in the owner's timezone. */
function pollTime(iso: string, timeZone: string) {
  const options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  };
  try {
    return new Date(iso).toLocaleString('en-US', {
      ...options,
      timeZone: timeZone || 'UTC',
    });
  } catch {
    return new Date(iso).toLocaleString('en-US', { ...options, timeZone: 'UTC' });
  }
}
function sourceName(source: Subscription) {
  return source.title || source.origin;
}
function sourceLetter(source: Subscription) {
  const name = source.title || source.origin.replace(/^https?:\/\/(www\.)?/, '');
  return [...name.trim()][0] ?? '?';
}
/** The subscription row's one-line status, in the alert colour when failing. */
function sourceStatus(source: Subscription, timeZone: string) {
  const polled = source.last_poll_at
    ? `last polled ${pollTime(source.last_poll_at, timeZone)}`
    : 'never polled';
  if (source.status === 'paused') return { text: 'paused', bad: false };
  if (source.fail_count > 0)
    return { text: `${source.fail_count} failures · ${polled}`, bad: true };
  return {
    text: `${source.kind === 'rss' ? 'legacy rss · ' : ''}${polled}`,
    bad: false,
  };
}
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast('copied');
    return;
  } catch {
    /* fall through: older browsers and denied permissions */
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  area.remove();
  if (copied) toast('copied');
  else await prompt({ title: 'copy text', defaultValue: text, ok: 'done' });
}
async function share(title: string, text: string, url: string) {
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
    } catch {
      /* dismissed */
    }
    return;
  }
  await copy(`${text}\n\n${url}`);
  toast('no share sheet here — copied text + link instead');
}
function entryTitle(html: string) {
  const first = new DOMParser().parseFromString(html, 'text/html').body
    .firstElementChild;
  return first && /^H[1-6]$/.test(first.tagName)
    ? (first.textContent ?? '').trim()
    : '';
}
function plainExcerpt(html: string) {
  const text =
    new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 280);
}

/** Errors and draft creation shared by every reading screen. */
function useReadingActions() {
  const [error, setError] = useState<unknown>();
  const navigate = useNavigate();
  const run = async (action: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await action();
    } catch (failure) {
      setError(failure);
    }
  };
  const openDraft = async (body: CreateItemData['body']) => {
    const created = await unwrap(BlyggerApi.createItem({ client, body }));
    await changed('items');
    await navigate({ to: '/edit/$id', params: { id: created.id } });
  };
  return { error, setError, run, openDraft, navigate };
}
type Actions = ReturnType<typeof useReadingActions>;

/* ---------------- read state (migration 0026) ---------------- */

type Markable = Pick<Reading, 'key' | 'imported'>;
/**
 * Mark imported entries read (at the version held here) or unread. Loaded
 * reading rows for them change at once and roll back if the write fails.
 */
function markEntries(entries: Markable[], read: boolean) {
  const rows = entries.filter((entry) => entry.imported);
  return markReading({ keys: rows.map((entry) => entry.key), read, writes: readWrites(rows, read) }).when('settled');
}
interface ReadUi {
  /** Whether rows show read state and can be selected (timelines; not hoppers). */
  shown: boolean;
  selecting: boolean;
  selected: ReadonlySet<string>;
  toggle: (key: string) => void;
  /** The owner opened this entry: expanded it or followed it to its origin. */
  opened: (entry: Reading) => void;
}
const ReadContext = createContext<ReadUi>({
  shown: false,
  selecting: false,
  selected: new Set(),
  toggle: () => {},
  opened: () => {},
});

/* ---------------- entry body ---------------- */

/**
 * The entry's opening heading (or an L0 entry's lone title link) becomes its
 * title; the rest is the body. Shared by the card and the full view.
 */
function splitTitle(html: string, l0: boolean) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const first = parsed.body.firstElementChild;
  let title: string | undefined;
  if (
    first &&
    (/^H[1-6]$/.test(first.tagName) ||
      (l0 &&
        first.tagName === 'P' &&
        first.children.length === 1 &&
        first.firstElementChild?.tagName === 'A'))
  ) {
    title = first.textContent || undefined;
    first.remove();
  }
  return { title, html: parsed.body.innerHTML };
}
function EntryTitle({ title, url, as: Tag = 'h3', className = 'entry-title' }: { title?: string; url?: string; as?: 'h2' | 'h3'; className?: string }) {
  if (!title) return null;
  return (
    <Tag className={className}>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer">
          {title}
        </a>
      ) : (
        title
      )}
    </Tag>
  );
}
/**
 * The card's body, clamped. "more" opens the entry's full view (and so does
 * a tap on the clamped text itself); it shows whenever the text is cut, which
 * is measured again as images inside it load and change its height.
 */
function Body({ html, url, l0, onMore }: { html: string; url?: string; l0: boolean; onMore: () => void }) {
  const [overflow, setOverflow] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const content = useMemo(() => splitTitle(html, l0), [html, l0]);
  useEffect(() => {
    const element = body.current;
    if (!element) return;
    const measure = () =>
      setOverflow(element.scrollHeight > element.clientHeight + 1);
    // The box stops resizing once it reaches the clamp, but its content keeps
    // growing as images load: watch both, and every image's load.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    element.addEventListener('load', measure, true);
    measure();
    return () => {
      observer.disconnect();
      element.removeEventListener('load', measure, true);
    };
  }, [content.html]);
  return (
    <>
      <EntryTitle title={content.title} url={url} />
      <div
        ref={body}
        className={`content entry-body clamped ${overflow ? 'overflowing' : ''}`}
        onClick={(event) => {
          // A tap on cut-off text is a way in too; links and selections keep theirs.
          if (!overflow || (event.target as Element).closest('a, button')) return;
          if (!(window.getSelection()?.isCollapsed ?? true)) return;
          onMore();
        }}
        dangerouslySetInnerHTML={{ __html: content.html }}
      />
      {overflow ? (
        <Button className="more expand-btn" onClick={onMore}>
          more
        </Button>
      ) : null}
    </>
  );
}
function canLink(entry: Reading) {
  return (
    !entry.l0 &&
    (entry.own
      ? !entry.withdrawn
      : !entry.withdrawn || entry.imported?.pinnedVersionRetained != null)
  );
}
/** Imported, blyg-native and linkable: the entries a passage can be quoted from. */
function canQuote(entry: Reading) {
  return !!entry.imported && !entry.l0 && canLink(entry);
}
function entryParts(entry: Reading) {
  const imported = entry.imported;
  const id = entry.own?.id || imported!.remoteId;
  const url = entry.own
    ? !entry.withdrawn
      ? `${location.origin}${mount}/${entry.kind === 'thread' ? 't' : 'f'}/${id}/`
      : undefined
    : imported?.sourceUrl || undefined;
  // Own items are stubbed as hoppers address them, `~own` (session 50).
  const source = imported
    ? { subscription_id: imported.subscriptionId, remote_id: imported.remoteId }
    : entry.own
      ? { subscription_id: OWN_SUB, remote_id: entry.own.id }
      : undefined;
  return { imported, id, url, source };
}

/* ---------------- the full view's address ---------------- */

/** The `sub` segment of an own item's full view (the hoppers' own-post id). */
const OWN_SUB = '~own';
/** Where an entry's full view lives: /reading/{sub}/{id}, `~own` for your own. */
export function articleParams(entry: Reading) {
  return entry.own || entry.imported?.subscriptionId === OWN_SUB
    ? { sub: OWN_SUB, id: entry.own?.id ?? entry.imported!.remoteId }
    : { sub: entry.imported!.subscriptionId, id: entry.imported!.remoteId };
}
/**
 * The feed position to come back to. Set when an entry's full view opens,
 * read once by the timeline it was opened from: the entry's key and how far
 * from the top of the viewport it sat, so back lands on the same item.
 */
type ReturnPoint = { href: string; key: string; top: number; y: number };
// Kept in sessionStorage too, so the browser's back after a reload of the
// full view still lands on the entry; memory alone when storage is refused.
const RETURN_KEY = 'studio.reading.return';
let returnPoint: ReturnPoint | null = null;
function setReturnPoint(point: ReturnPoint | null) {
  returnPoint = point;
  try {
    if (point) sessionStorage.setItem(RETURN_KEY, JSON.stringify(point));
    else sessionStorage.removeItem(RETURN_KEY);
  } catch {
    /* private mode or blocked storage: memory only */
  }
}
function takeReturnPoint(): ReturnPoint | null {
  let point = returnPoint;
  if (!point)
    try {
      point = JSON.parse(sessionStorage.getItem(RETURN_KEY) ?? 'null') as ReturnPoint | null;
    } catch {
      point = null;
    }
  if (!point || point.href !== feedHref()) return null;
  setReturnPoint(null);
  return point;
}
const feedHref = () => location.pathname + location.search;
/** Put the timeline back where the full view was opened from. */
function useReturnPoint(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    const point = takeReturnPoint();
    if (!point) return;
    const restore = () => {
      const element = document.querySelector<HTMLElement>(`.reading-entry[data-key="${CSS.escape(point.key)}"]`);
      const y = element ? element.getBoundingClientRect().top + window.scrollY - point.top : point.y;
      window.scrollTo(0, y);
    };
    // After the router's own scroll handling for the navigation, and again
    // once late layout (images above) has settled.
    const frame = requestAnimationFrame(() => requestAnimationFrame(restore));
    const late = setTimeout(restore, 250);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(late);
    };
  }, [ready]);
}
/** Whether this full view was opened from a timeline in this session (so back is history's back). */
let openedFromFeed = false;
function useOpenArticle(entry: Reading) {
  const navigate = useNavigate();
  return () => {
    const element = document.querySelector<HTMLElement>(`.reading-entry[data-key="${CSS.escape(entry.key)}"]`);
    setReturnPoint({ href: feedHref(), key: entry.key, top: element?.getBoundingClientRect().top ?? 0, y: window.scrollY });
    openedFromFeed = true;
    void navigate({ to: '/reading/$sub/$id', params: articleParams(entry) });
  };
}

/* ---------------- an entry's actions (card and full view) ---------------- */

function useEntryActions({
  entry,
  actions,
  votes,
  buckets,
  opened,
}: {
  entry: Reading;
  actions: Actions;
  votes: SignalRow[];
  buckets: Hopper[];
  /** The owner followed the entry to its origin. */
  opened: () => void;
}) {
  const { run, openDraft, navigate } = actions;
  const settings = useSettings();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [extensionSheet, setExtensionSheet] = useState<OpenSheet | null>(null);
  const extensions = enabledExtensions(compiledExtensions, settings?.extensions);
  const { imported, id, url, source } = entryParts(entry);
  const signal = votes.find(
    (vote) =>
      vote.subscription_id === imported?.subscriptionId &&
      vote.remote_id === imported.remoteId,
  );
  const vote = (thumb: 1 | -1) =>
    run(async () => {
      if (!imported) return;
      const path = { sub: imported.subscriptionId, remoteId: id };
      if (signal?.thumb === thumb)
        await unwrap(BlyggerApi.deleteSignal({ client, path }));
      else
        await unwrap(BlyggerApi.setSignal({ client, path, body: { thumb } }));
      await changed('signals');
    });
  const stub = () =>
    source ? run(() => openDraft({ mode: 'response', source })) : undefined;
  const linkPost = () =>
    void run(() => openDraft({ content_md: `[[${id}]]\n\n`, kind: 'fragment' }));
  const forkPage = () => {
    if (imported)
      void navigate({ to: '/fork', search: { id, sub: imported.subscriptionId } });
    // No sub: the fork page reads our own origin's pins.
    else if (entry.own) void navigate({ to: '/fork', search: { id } });
  };
  const canFork = (canQuote(entry) && !!imported) || (!!entry.own && canLink(entry));
  const openPage = () => {
    opened();
    void window.open(url, '_blank', 'noreferrer');
  };
  // What an extension's slots see of this entry (extension-api.ts). Built only
  // when an extension asks, so an entry with none enabled does no extra work.
  const extensionContext = (extension: StudioExtension): EntryContext => ({
    entry,
    id,
    imported: imported
      ? { subscriptionId: imported.subscriptionId, remoteId: imported.remoteId }
      : undefined,
    url,
    client,
    openDraft,
    navigate: (location) => navigate(location as never),
    run: (action) => run(async () => action()),
    actions: {
      stub: source ? () => void stub() : undefined,
      fork: canFork ? forkPage : undefined,
      linkPost: canLink(entry) ? linkPost : undefined,
      history: imported && !entry.l0 ? () => setHistoryOpen(true) : undefined,
      open: url ? openPage : undefined,
    },
    openSheet: (render) => setExtensionSheet({ name: extension.name, render }),
  });
  const hopperSub = imported?.subscriptionId ?? (entry.own ? OWN_SUB : undefined);
  const addToHopper = () =>
    run(async () => {
      if (!hopperSub) return;
      const chosen = await menu({
        title: '+ add to hopper…',
        rows: [
          ...buckets.map((bucket) => ({
            key: `hopper:${bucket.id}`,
            icon: '▤',
            label: bucket.name,
          })),
          { key: 'new', icon: '＋', label: 'new hopper…' },
        ],
      });
      if (!chosen) return;
      let hopperId = chosen.slice('hopper:'.length);
      let name = buckets.find((bucket) => bucket.id === hopperId)?.name;
      if (chosen === 'new') {
        const typed = await prompt({ title: 'Name the new hopper:' });
        if (!typed?.trim()) return;
        const hopper = await unwrap(
          BlyggerApi.createHopper({ client, body: { name: typed } }),
        );
        hopperId = hopper.id;
        name = hopper.name;
      }
      await unwrap(
        BlyggerApi.addHopperItem({
          client,
          path: { id: hopperId, sub: hopperSub, remoteId: id },
        }),
      );
      await changed('hoppers', 'hopper', 'hopper-preview');
      toast(`added to ${name}`);
    });
  const openMenu = async () => {
    await menu({
      rows: [
        canLink(entry) && {
          icon: '⇢',
          label: 'link post ↗',
          onSelect: linkPost,
        },
        canFork && {
          icon: '⑂',
          label: 'fork',
          onSelect: forkPage,
        },
        canLink(entry) && {
          icon: '⟦',
          label: 'copy [[id]]',
          // The long form (#70): the label is the text the link would show anyway.
          onSelect: () => void copy(linkSource(id, linkLabel(entry.contentHtml, entry.kind))),
        },
        !!url && {
          icon: '⧉',
          label: 'copy url',
          onSelect: () => void copy(url!),
        },
        !!url && {
          icon: '⇪',
          label: 'share…',
          onSelect: () =>
            void share(
              entryTitle(entry.contentHtml),
              plainExcerpt(entry.contentHtml),
              url!,
            ),
        },
        !!url && {
          key: 'open',
          icon: '↗',
          label: `${displayUrl(url!)} ↗`,
          description: url,
          onSelect: openPage,
        },
        !!imported &&
          !entry.l0 && {
            key: 'history',
            icon: '⟲',
            label: historyOpen ? 'hide history' : 'history',
            onSelect: () => setHistoryOpen((open) => !open),
          },
        ...entryActionRows(extensions, extensionContext),
      ],
    });
  };
  return {
    imported,
    id,
    url,
    signal,
    vote,
    stub,
    addToHopper,
    openMenu,
    historyOpen,
    extensions,
    extensionContext,
    extensionSheet,
    closeExtensionSheet: () => setExtensionSheet(null),
  };
}
type EntryActions = ReturnType<typeof useEntryActions>;

/** The byline: kind, legacy rss, source and date, plus the extensions' slot. */
function Byline({ entry, a, children }: { entry: Reading; a: EntryActions; children?: ReactNode }) {
  const settings = useSettings();
  const date = formatDateIn(entry.displayAt, settings?.timezone || 'UTC');
  return (
    <p className="byline">
      {children}
      <span className="badge">{entry.kind}</span>
      {entry.l0 ? <span className="badge badge-line">legacy rss</span> : null}
      <span className="src">{a.imported?.subscriptionTitle || 'you'}</span>
      <span>· {date}</span>
      <EntryBylineSlot extensions={a.extensions} context={a.extensionContext} />
    </p>
  );
}
function Tomb({ entry }: { entry: Reading }) {
  return entry.withdrawn ? (
    <p className="tomb">
      withdrawn
      {entry.imported?.pinnedVersionRetained != null
        ? ` · retained pinned v${entry.imported.pinnedVersionRetained}`
        : ''}
    </p>
  ) : null;
}
/**
 * The action row, the same on the card and in the full view: line-icon
 * thumbs, then edit / stub ↗ / + add to hopper… as quiet text, then ⋯.
 * Small to look at; every control is still a 40px target (.act).
 */
function EntryBar({ entry, a }: { entry: Reading; a: EntryActions }) {
  const { imported, id, signal } = a;
  return (
    <div className="entry-bar">
      {imported
        ? ([1, -1] as const).map((thumb) => (
            <Button
              key={thumb}
              className="act icon-only thumb"
              aria-label={thumb === 1 ? 'thumbs up' : 'thumbs down'}
              title={thumb === 1 ? 'thumbs up' : 'thumbs down'}
              aria-pressed={signal?.thumb === thumb}
              onClick={() => void a.vote(thumb)}
            >
              {thumb === 1 ? <ThumbUp /> : <ThumbDown />}
            </Button>
          ))
        : null}
      <span className="spacer" />
      {entry.own ? (
        <Link className="act" to="/edit/$id" params={{ id }}>
          edit
        </Link>
      ) : null}
      {imported || entry.own ? (
        <>
          <Button
            className="act"
            data-action="stub"
            data-sub={imported?.subscriptionId ?? OWN_SUB}
            data-remote={id}
            onClick={() => void a.stub()}
          >
            stub ↗
          </Button>
          <Button
            className="act"
            aria-label="add to hopper"
            title="add to hopper"
            onClick={() => void a.addToHopper()}
          >
            + add to hopper…
          </Button>
        </>
      ) : null}
      <Button
        className="act icon-only more-btn"
        aria-label="more actions"
        title="more actions"
        // Keep a text selection alive through the press.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void a.openMenu()}
      >
        <More />
      </Button>
    </div>
  );
}

/* ---------------- one entry ---------------- */

function Entry({
  entry,
  actions,
  votes,
  buckets,
}: {
  entry: Reading;
  actions: Actions;
  votes: SignalRow[];
  buckets: Hopper[];
}) {
  const readUi = useContext(ReadContext);
  const status = readUi.shown ? readStatus(entry.imported) : null;
  const opened = () => {
    if (entry.imported) readUi.opened(entry);
  };
  const a = useEntryActions({ entry, actions, votes, buckets, opened });
  const { imported, id, url, signal } = a;
  const openArticle = useOpenArticle(entry);
  const swipe = useSwipe<HTMLDivElement>(
    imported
      ? {
          onRight: () => void a.vote(1),
          onLeft: () => void a.stub(),
          mouseFrom: '.byline, .entry-bar',
          mover: '.entry',
        }
      : {},
  );
  return (
    <div
      ref={swipe}
      className="swipe"
      data-swipe={imported ? 'entry' : undefined}
    >
      {imported ? (
        <div className="swipe-bg" aria-hidden="true">
          <span className="sl">
            👍 {signal?.thumb === 1 ? 'clear' : 'thumb up'}
          </span>
          <span className="sr">stub ↗</span>
        </div>
      ) : null}
      <article
        className={`entry reading-entry${status ? ` is-${status}` : ''}`}
        data-key={entry.key}
        data-read={status ?? undefined}
      >
        <div
          className="entry-in"
          // Following the entry to its origin (title or source link) opens it.
          onClick={(event) => {
            if ((event.target as Element).closest('.entry-title a, a.entry-src')) opened();
          }}
        >
          <Byline entry={entry} a={a}>
            {readUi.selecting && imported ? (
              <label className="entry-select">
                <input
                  type="checkbox"
                  aria-label={`select ${entryTitle(entry.contentHtml) || plainExcerpt(entry.contentHtml).slice(0, 40) || imported.remoteId}`}
                  checked={readUi.selected.has(entry.key)}
                  onChange={() => readUi.toggle(entry.key)}
                />
              </label>
            ) : null}
            {status === 'unread' || status === 'updated' ? (
              <span
                className={`read-dot ${status}`}
                role="img"
                aria-label={status === 'unread' ? 'unread' : 'updated since read'}
                title={status === 'unread' ? 'unread' : 'updated since you read it'}
              />
            ) : null}
          </Byline>
          <Tomb entry={entry} />
          <ChangeLead entry={entry} />
          <Body html={entry.contentHtml} url={url} l0={entry.l0} onMore={openArticle} />
          <SourceLink url={url} />
        </div>
        {imported && !entry.l0 && a.historyOpen ? (
          <History sub={imported.subscriptionId} id={id} />
        ) : null}
        <EntryBar entry={entry} a={a} />
        <EntrySheetSlot sheet={a.extensionSheet} close={a.closeExtensionSheet} />
      </article>
    </div>
  );
}

/* ---------------- the full view ---------------- */

/* ---------------- what changed (new versions in the feed) ---------------- */

// The note for one held version, read from the origin's changelog once a card
// has been on screen (decision #40's reader half: the importer stores the
// latest state, not the changelog). Failures are not kept, so a blyg that was
// briefly unreachable is asked again.
const changeNotes = new Map<string, Promise<string | null>>();
function changeNote(sub: string, id: string, version: number): Promise<string | null> {
  const key = JSON.stringify([sub, id, version]);
  let note = changeNotes.get(key);
  if (!note) {
    note = loadHistory(sub, id).then(
      (history) => history.changelog.find((entry) => entry.version === version)?.note?.trim() || null,
    );
    note.catch(() => changeNotes.delete(key));
    changeNotes.set(key, note);
  }
  return note;
}
/**
 * A revised post leads with its latest changelog entry: "V3: note". When the
 * origin gave none for that version (or cannot be reached) it says so rather
 * than showing nothing, so a changed post never reads like an unchanged one.
 * Only a held, blyg-native, live item past its first version has one.
 */
function ChangeLead({ entry }: { entry: Reading }) {
  const imported = entry.imported;
  const version = imported?.version ?? 0;
  const eligible = !!imported && !entry.l0 && !entry.withdrawn && version > 1;
  const line = useRef<HTMLParagraphElement>(null);
  const [note, setNote] = useState<string | null | undefined>();
  useEffect(() => {
    setNote(undefined);
    const element = line.current;
    if (!eligible || !element) return;
    let live = true;
    const load = () =>
      changeNote(imported!.subscriptionId, imported!.remoteId, version).then(
        (value) => live && setNote(value),
        () => live && setNote(null),
      );
    // Only cards that come on screen ask their origin.
    const observer = new IntersectionObserver((seen) => {
      if (!seen.some((s) => s.isIntersecting)) return;
      observer.disconnect();
      void load();
    });
    observer.observe(element);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [entry.key, version, eligible]);
  if (!eligible) return null;
  return (
    <p ref={line} className={`change-lead${note === null ? ' none' : ''}`} data-change-lead>
      <strong>V{version}:</strong> {note === undefined ? '…' : note ?? 'No changelog entry available'}
    </p>
  );
}

/** An own item as a reading entry, for a full view opened by its address. */
async function ownEntry(id: string, signal?: AbortSignal): Promise<Reading> {
  const item = await unwrap(BlyggerApi.getItem({ client, path: { id }, signal }));
  const withdrawn = item.status === 'withdrawn';
  const contentHtml = withdrawn ? '' : (item.published?.content_html ?? '');
  const kind = item.authored_kind;
  return {
    key: `own:${id}`,
    source: 'own',
    kind,
    withdrawn,
    l0: false,
    contentHtml,
    displayAt: item.published?.published_at ?? item.updated,
    rank: 0,
    own: { id, kind, withdrawn, updated: item.updated, contentHtml },
  };
}
/** Route intent and the mounted article share their read, without polling. */
export function loadArticleEntry(sub: string, id: string): Promise<Reading> {
  const key = sub === OWN_SUB ? `own:${id}` : `imported:${JSON.stringify([sub, id])}`;
  const held = reading.toArray.find(row => row.key === key);
  if (held) return Promise.resolve(held);
  return queryClient.fetchQuery({
    queryKey: ['owner-read', 'reading-article', sub, id], staleTime: 30_000,
    queryFn: ({ signal }) => sub === OWN_SUB ? ownEntry(id, signal) :
      unwrap(BlyggerApi.getImportedItem({ client, path: { sub, id }, signal })).then(item => hopperEntry(item, subscriptions.get(sub), 0)),
  });
}
/** The entry an address names: from what reading already holds, else fetched. */
function useArticleEntry(sub: string, id: string) {
  const key = sub === OWN_SUB ? `own:${id}` : `imported:${JSON.stringify([sub, id])}`;
  const held = () => reading.toArray.find((row) => row.key === key);
  const [entry, setEntry] = useState<Reading | undefined>(held);
  const [error, setError] = useState<unknown>();
  const sources = useLiveQuery({ query: (q) => q.from({ source: subscriptions }) }).data;
  useEffect(() => {
    const row = held();
    if (row) {
      setEntry(row);
      return;
    }
    let live = true;
    setEntry(undefined);
    setError(undefined);
    loadArticleEntry(sub, id).then(
      (loaded) => live && setEntry(loaded),
      (failure) => live && setError(failure),
    );
    return () => {
      live = false;
    };
  }, [key]);
  // A fetched entry names its source once subscriptions have loaded.
  const source = sources?.find((row) => row.id === sub);
  const shown =
    entry?.imported && source && entry.imported.subscriptionTitle === sub
      ? { ...entry, imported: { ...entry.imported, subscriptionTitle: sourceName(source) } }
      : entry;
  return { entry: shown, error };
}
/**
 * One entry, full screen (/reading/{sub}/{id}): the whole post with its
 * citation line and the card's action row. Opening it marks it read, as
 * expanding a card did. Back returns to the timeline at the same entry.
 */
export function ReadingArticle({ sub, id }: { sub: string; id: string }) {
  useChrome({ framed: false, wide: false });
  const actions = useReadingActions();
  const navigate = useNavigate();
  const { entry, error } = useArticleEntry(sub, id);
  const subs = useSubscriptionRows();
  const origin = sub === OWN_SUB ? ownOrigin() : subs.find((s) => s.id === sub)?.origin;
  const back = () => {
    // Inside a walk through linked entries, back retraces it one entry at a time.
    if (currentTrail().stack.length > 1) window.history.back();
    else if (openedFromFeed && window.history.length > 1) {
      openedFromFeed = false;
      window.history.back();
    } else void actions.navigate({ to: '/reading' });
  };
  // The walk's record of this entry; the title is what the breadcrumb shows.
  useEffect(() => {
    if (!entry || !origin) return;
    const title = splitTitle(entry.contentHtml, entry.l0).title || plainExcerpt(entry.contentHtml).slice(0, 60);
    visit({ origin, id, version: entry.imported?.version ?? null, title });
  }, [entry?.key, origin]);
  // A held blyg whose copy lacks this item (never imported, or older than the
  // backfill): read it from its origin instead of showing an error.
  const notHeld = (error as { status?: number } | undefined)?.status === 404 || /not found/i.test(String((error as Error | undefined)?.message ?? ''));
  useEffect(() => {
    if (notHeld && origin && sub !== OWN_SUB) void navigate({ to: '/peek', search: { origin, id }, replace: true });
  }, [notHeld, origin]);
  return (
    <>
      <TrailBar back={back} />
      <Failure error={notHeld ? undefined : error ?? actions.error} />
      {entry ? (
        <Article entry={entry} actions={actions} origin={origin ?? ownOrigin()} />
      ) : !error ? (
        <p className="view-sub">Loading…</p>
      ) : null}
    </>
  );
}
function Article({ entry, actions, origin }: { entry: Reading; actions: Actions; origin: string }) {
  const votes = useLiveQuery({ query: (q) => q.from({ signal: signals }) }).data ?? [];
  const buckets = useLiveQuery({ query: (q) => q.from({ hopper: hoppers }) }).data ?? [];
  // Opening the full view is opening the entry: mark it read once, at the
  // version held here, as expanding a card did (0.39.0).
  const marked = useRef<string | null>(null);
  useEffect(() => {
    if (marked.current === entry.key) return;
    marked.current = entry.key;
    if (!needsRead(readStatus(entry.imported))) return;
    // A row reading holds is marked through it (every view updates at once);
    // one fetched by its address has no row to change, so it is written direct.
    const write = reading.toArray.some((row) => row.key === entry.key)
      ? markEntries([entry], true)
      : saveReadState(readWrites([entry], true).read, []).then(() => changed('reading'));
    void write.catch(() => toast('Could not store the read mark.'));
  }, [entry.key]);
  const a = useEntryActions({ entry, actions, votes, buckets, opened: () => {} });
  const content = useMemo(() => splitTitle(entry.contentHtml, entry.l0), [entry.contentHtml, entry.l0]);
  return (
    <article className="entry reading-article" data-key={entry.key}>
      <div className="entry-in">
        <Byline entry={entry} a={a} />
        <Tomb entry={entry} />
        <EntryTitle title={content.title} url={a.url} as="h2" className="entry-title article-title" />
        <ReaderBody html={content.html} origin={origin} className="content entry-body article-body" />
        <SourceLink url={a.url} />
      </div>
      {a.imported && !entry.l0 && a.historyOpen ? (
        <History sub={a.imported.subscriptionId} id={a.id} />
      ) : null}
      <EntryBar entry={entry} a={a} />
      <EntrySheetSlot sheet={a.extensionSheet} close={a.closeExtensionSheet} />
    </article>
  );
}

/** Entries and the error line above them. */
function EntryList({
  entries,
  actions,
}: {
  entries: Reading[];
  actions: Actions;
}) {
  const votes =
    useLiveQuery({ query: (q) => q.from({ signal: signals }) }).data ?? [];
  const buckets =
    useLiveQuery({ query: (q) => q.from({ hopper: hoppers }) }).data ?? [];
  return (
    <>
      {entries.map((entry) => (
        <Entry
          key={entry.key}
          entry={entry}
          actions={actions}
          votes={votes}
          buckets={buckets}
        />
      ))}
    </>
  );
}
function Pager({
  offset,
  total,
  go,
}: {
  offset: number;
  total: number | undefined;
  go: (offset: number) => void;
}) {
  return (
    <div className="pager reading-pager">
      <Button
        className="btn btn-ghost btn-mini"
        disabled={offset === 0}
        onClick={() => go(offset - PAGE)}
      >
        newer
      </Button>
      <span className="pager-info">
        page {offset / PAGE + 1} of{' '}
        {readingPage(String(offset / PAGE + 1), total ?? 0).pages}
      </span>
      <Button
        className="btn btn-ghost btn-mini"
        disabled={total === undefined || offset + PAGE >= total}
        onClick={() => go(offset + PAGE)}
      >
        older
      </Button>
    </div>
  );
}

/* ---------------- the inspector and subscribe sheets ---------------- */

function useSubscriptionActions(actions: Actions) {
  const toggle = (source: Subscription) =>
    actions.run(async () => {
      const paused = source.status === 'paused';
      await subscriptions.update(source.id, (row) => {
        row.status = paused ? 'active' : 'paused';
      }).when('settled');
      toast(paused ? 'resumed' : 'paused');
    });
  return { toggle };
}
function Inspector({
  source,
  count,
  onClose,
  actions,
  onDeleted,
}: {
  source: Subscription | undefined;
  count: number | undefined;
  onClose: () => void;
  actions: Actions;
  onDeleted?: () => void;
}) {
  const settings = useSettings();
  const [error, setError] = useState<unknown>();
  const { toggle } = useSubscriptionActions(actions);
  // Keep the last source so the sheet can animate shut after a delete.
  const last = useRef(source);
  if (source) last.current = source;
  const shown = source ?? last.current;
  useEffect(() => setError(undefined), [source?.id]);
  if (!shown) return null;
  const timeZone = settings?.timezone || 'UTC';
  const flags = shown.flags
    .map((flag) => `${flag.type}: ${flag.detail || ''}`)
    .join(' · ');
  return (
    <Sheet
      open={!!source}
      onClose={onClose}
      title={sourceName(shown)}
      className="inspector"
    >
      <dl>
        <dt>origin</dt>
        <dd>
          <a href={shown.origin} target="_blank" rel="noreferrer">
            {shown.origin}
          </a>
        </dd>
        <dt>type</dt>
        <dd>
          {shown.kind === 'rss' ? 'legacy rss' : shown.kind}
          {flags ? ` · ${flags}` : ''}
        </dd>
        <dt>polled</dt>
        <dd>
          {shown.status === 'paused' ? 'paused · ' : ''}
          {shown.last_poll_at
            ? `last polled ${pollTime(shown.last_poll_at, timeZone)}`
            : 'never polled'}
        </dd>
        <dt>failures</dt>
        <dd className={shown.fail_count ? 'bad' : undefined}>
          {shown.fail_count}
        </dd>
        <dt>items</dt>
        <dd>{count ?? '…'}</dd>
      </dl>
      <label className="check">
        <input
          type="checkbox"
          checked={shown.in_blogroll}
          onChange={(event) => {
            const checked = event.target.checked;
            setError(undefined);
            subscriptions
              .update(shown.id, (row) => {
                row.in_blogroll = checked;
              })
              .when('settled').then(
                () =>
                  toast(
                    checked ? 'added to blogroll' : 'removed from blogroll',
                  ),
                setError,
              );
          }}
        />
        <span>
          in blogroll
          <span className="hint">
            Listed in your public <code>blogroll.opml</code>.
          </span>
        </span>
      </label>
      <Failure error={error} />
      <ul className="menu-list">
        <li>
          <Button
            onClick={() => {
              onClose();
              void toggle(shown);
            }}
          >
            <span className="mi" aria-hidden="true">
              {shown.status === 'paused' ? '▶' : '‖'}
            </span>
            <span className="ml">
              {shown.status === 'paused' ? 'resume' : 'pause'}
            </span>
          </Button>
        </li>
        {shown.kind === 'blyg' ? (
          <li>
            <Button
              onClick={() => {
                onClose();
                void actions.run(async () => {
                  const result = await unwrap(
                    BlyggerApi.resyncSubscription({
                      client,
                      path: { id: shown.id },
                    }),
                  );
                  await changed('subscriptions', 'reading');
                  toast(`resynced · ${result.changed} changed`);
                });
              }}
            >
              <span className="mi" aria-hidden="true">
                ⟲
              </span>
              <span className="ml">resync</span>
            </Button>
          </li>
        ) : null}
        <li>
          <Button
            className="danger"
            onClick={async () => {
              onClose();
              if (
                await confirm({
                  title:
                    'Delete this subscription and its local imports, hopper memberships, and signals?',
                  ok: 'delete',
                  danger: true,
                })
              )
                void actions.run(async () => {
                  await subscriptions.delete(shown.id).when('settled');
                  await changed('hoppers', 'signals', 'reading');
                  toast('deleted');
                  onDeleted?.();
                });
            }}
          >
            <span className="mi" aria-hidden="true">
              ✕
            </span>
            <span className="ml">delete</span>
          </Button>
        </li>
      </ul>
    </Sheet>
  );
}
function SubscribeSheet({
  open,
  onClose,
  onImport,
}: {
  open: boolean;
  onClose: () => void;
  onImport: () => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="subscribe">
      <AddFeedForm
        onSubscribed={() => {
          onClose();
          toast('subscribed');
        }}
      />
      <div className="sheet-actions add-sub-more">
        <Button
          className="btn btn-ghost"
          onClick={() => {
            onClose();
            onImport();
          }}
        >
          import an OPML file…
        </Button>
      </div>
    </Sheet>
  );
}

/* ---------------- lenses (0.25.0) ---------------- */

const LensContext = createContext<Lens>('all');
/** The current lens as search params, for links that should keep it. */
function useLensSearch(): { lens?: Lens } {
  const lens = useContext(LensContext);
  return lens === 'all' ? {} : { lens };
}
const LENS_LABELS: Record<Lens, string> = {
  all: 'All',
  threads: 'Threads',
  fragments: 'Fragments',
  background: 'Background',
  smart: 'Smart Feed',
};
/**
 * The lens bar at the top of every reading screen. All, Threads and Fragments
 * filter whatever is open (the sources list's counts too); Background and
 * Smart Feed are placeholders that telegraph where reading is going.
 */
function LensBar({ sub, hopper, sources }: { sub?: string; hopper?: string; sources?: boolean }) {
  const lens = useContext(LensContext);
  const navigate = useNavigate();
  const bar = useRef<HTMLDivElement>(null);
  // On a phone the bar scrolls sideways; keep the chosen lens in view.
  useEffect(() => {
    const el = bar.current?.querySelector<HTMLElement>('[aria-pressed=true]');
    const box = bar.current;
    if (!el || !box) return;
    // Scroll only the bar, never the page.
    if (el.offsetLeft + el.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollLeft = el.offsetLeft + el.offsetWidth - box.clientWidth;
    else if (el.offsetLeft < box.scrollLeft) box.scrollLeft = el.offsetLeft;
  }, [lens]);
  const place = sources
    ? { view: 'sources' as const }
    : hopper
      ? { hopper, offset: 0 }
      : sub && sub !== 'all'
        ? { sub, offset: 0 }
        : {};
  // Buttons, not router Links: a Link to /reading counts as "current" under
  // every lens, which would mark All active alongside the real choice.
  return (
    <div ref={bar} className="segmented lens-bar" role="group" aria-label="reading lens">
      {LENSES.map((value) => (
        <Button
          key={value}
          className={`seg${lens === value ? ' is-active' : ''}${value === 'smart' ? ' seg-dashed' : ''}`}
          aria-pressed={lens === value}
          onClick={() =>
            void navigate({ to: '/reading', search: { ...place, ...(value === 'all' ? {} : { lens: value }) } })
          }
        >
          {LENS_LABELS[value]}
        </Button>
      ))}
    </div>
  );
}
/** Withdrawn posts are background: every other lens leaves them out. */
export const BACKGROUND_NOTE = 'Withdrawn posts, yours and the blygs you read. They are kept out of the other views.';
export const SMART_FEED_NOTE = 'Coming soon. Feed sorted and filtered by your AI agent. You can already set its prompt in Settings.';
const isPlaceholder = (lens: Lens): lens is 'smart' => lens === 'smart';
function LensPlaceholder() {
  return (
    <div className="empty lens-placeholder">
      <span className="em" aria-hidden="true">
        ✦
      </span>
      <strong>Coming soon.</strong> Feed sorted and filtered by your AI agent.
      You can already set its prompt in <Link to="/settings">Settings</Link>.
    </div>
  );
}

/* ---------------- the sources list ---------------- */

function SubscriptionRow({
  source,
  count,
  onInspect,
  onToggle,
}: {
  source: Subscription;
  count: number | undefined;
  onInspect: () => void;
  onToggle: () => void;
}) {
  const lensSearch = useLensSearch();
  const settings = useSettings();
  const swipe = useSwipe<HTMLLIElement>({
    onLeft: onInspect,
    onRight: onToggle,
  });
  const paused = source.status === 'paused';
  const status = sourceStatus(source, settings?.timezone || 'UTC');
  return (
    <li
      ref={swipe}
      className={paused ? 'feed paused' : 'feed'}
      data-swipe="feed"
      data-id={source.id}
    >
      <div className="swipe-bg" aria-hidden="true">
        <span className="sl">{paused ? '▶ resume' : '‖ pause'}</span>
        <span className="sr">ⓘ info</span>
      </div>
      <div className="feed-in">
        <Link
          to="/reading"
          search={{ sub: source.id, offset: 0, ...lensSearch }}
          draggable={false}
        >
          <span className="fi" aria-hidden="true">
            {sourceLetter(source)}
          </span>
          <span className="fm">
            <span className="ft">{sourceName(source)}</span>
            <span className={status.bad ? 'fs bad' : 'fs'}>{status.text}</span>
          </span>
          <span className="fn">{count ?? ''}</span>
          <span className="chev" aria-hidden="true">
            ›
          </span>
        </Link>
        <Button
          className="info"
          aria-label={`about ${sourceName(source)}`}
          onClick={onInspect}
        >
          ⓘ
        </Button>
      </div>
    </li>
  );
}
function HopperSource({ id, name }: { id: string; name: string }) {
  const lensSearch = useLensSearch();
  const collection = useMemo(() => hopperPreview(id), [id]);
  const row = useLiveQuery({ query: (q) => q.from({ hopper: collection }) })
    .data?.[0];
  return (
    <li className="feed">
      <div className="feed-in">
        <Link to="/reading" search={{ hopper: id, offset: 0, ...lensSearch }}>
          <span className="fi" aria-hidden="true">
            ▤
          </span>
          <span className="fm">
            <span className="ft">{name}</span>
            {row ? (
              <span className="fs">
                {row.source_count} source{row.source_count === 1 ? '' : 's'} ·{' '}
                {row.hopper.public ? 'public' : 'private'}
              </span>
            ) : null}
          </span>
          <span className="fn">{row?.total ?? ''}</span>
          <span className="chev" aria-hidden="true">
            ›
          </span>
        </Link>
      </div>
    </li>
  );
}
function SmartSource({
  sub,
  icon,
  title,
  count,
}: {
  sub: 'all' | 'own';
  icon: string;
  title: string;
  count: number | undefined;
}) {
  const lensSearch = useLensSearch();
  return (
    <li className="feed">
      <div className="feed-in">
        <Link to="/reading" search={{ sub, offset: 0, ...lensSearch }}>
          <span className="fi smart" aria-hidden="true">
            {icon}
          </span>
          <span className="fm">
            <span className="ft">{title}</span>
          </span>
          <span className="fn">{count ?? ''}</span>
          <span className="chev" aria-hidden="true">
            ›
          </span>
        </Link>
      </div>
    </li>
  );
}
function Sources() {
  useChrome({ framed: false, wide: false });
  const actions = useReadingActions();
  const { toggle } = useSubscriptionActions(actions);
  const [inspect, setInspect] = useState<string>();
  const [importing, setImporting] = useState(false);
  // The first page of "all" carries the counts for every source; it is also
  // what tapping "all" shows, so it is warm when that happens.
  const lens = useContext(LensContext);
  const allKey = readingKey('all', lens);
  useLiveQuery(readingView(allKey, 0));
  const sources =
    useLiveQuery({ query: (q) => q.from({ source: subscriptions }) }).data ??
    [];
  const buckets =
    useLiveQuery({ query: (q) => q.from({ hopper: hoppers }) }).data ?? [];
  const counts = readingMeta(allKey, 0)?.counts;
  const inspected = sources.find((source) => source.id === inspect);
  return (
    <>
      <ReadingHead
        active="sources"
        title="sources"
        count={sources.length}
        unit="subscriptions"
      />
      <LensBar sources />
      <Failure error={actions.error} />
      {isPlaceholder(lens) ? (
        <LensPlaceholder />
      ) : (
        <>
      <div className="list-h">
        <span>sources</span>
      </div>
      <ul className="feeds" aria-label="sources">
        <SmartSource sub="all" icon="◫" title="all" count={counts?.all} />
        <SmartSource sub="own" icon="❝" title="my blyg" count={counts?.own} />
      </ul>
      <div className="list-h">
        <span>hoppers · {buckets.length}</span>
        <Link to="/hoppers">manage</Link>
      </div>
      {buckets.length ? (
        <ul className="feeds" aria-label="hoppers">
          {buckets.map((bucket) => (
            <HopperSource key={bucket.id} id={bucket.id} name={bucket.name} />
          ))}
        </ul>
      ) : null}
      <div className="list-h">
        <span>subscriptions · {sources.length}</span>
        <span className="list-h-actions">
          {sources.filter((source) => source.in_blogroll).length} in blogroll
          <Button className="link-btn" id="opml-open" onClick={() => setImporting(true)}>
            import OPML
          </Button>
        </span>
      </div>
      {sources.length ? (
        <>
          <ul className="feeds" aria-label="subscriptions">
            {sources.map((source) => (
              <SubscriptionRow
                key={source.id}
                source={source}
                count={counts?.subscriptions[source.id]}
                onInspect={() => setInspect(source.id)}
                onToggle={() => void toggle(source)}
              />
            ))}
          </ul>
          <p className="hint sources-hint">
            Swipe a source ← for its info, → to pause or resume. Or tap ⓘ.
          </p>
        </>
      ) : (
        <div className="empty">
          <span className="em" aria-hidden="true">
            ◫
          </span>
          No subscriptions yet — tap ＋ to subscribe to a blyg or a feed.
        </div>
      )}
        </>
      )}
      <Inspector
        source={inspected}
        count={inspected ? counts?.subscriptions[inspected.id] : undefined}
        onClose={() => setInspect(undefined)}
        actions={actions}
      />
      <OpmlImportSheet open={importing} onClose={() => setImporting(false)} />
    </>
  );
}

/* ---------------- timelines ---------------- */

/** Feed and Sources: reading's two screens, peers, Feed first. */
function ReadingTabs({ active }: { active: 'feed' | 'sources' }) {
  const navigate = useNavigate();
  const lensSearch = useLensSearch();
  return (
    <div className="segmented reading-tabs" role="group" aria-label="reading view">
      {(['feed', 'sources'] as const).map((value) => (
        <Button
          key={value}
          className={`seg${active === value ? ' is-active' : ''}`}
          aria-pressed={active === value}
          onClick={() =>
            void navigate({
              to: '/reading',
              search: { ...(value === 'sources' ? { view: 'sources' as const } : {}), ...lensSearch },
            })
          }
        >
          {value === 'feed' ? 'Feed' : 'Sources'}
        </Button>
      ))}
    </div>
  );
}
/**
 * The head of every reading screen, the same under every lens so nothing
 * jumps: the Feed/Sources tabs, a title with its count, the screen's own
 * actions, and ＋ subscribe.
 */
function ReadingHead({
  active = 'feed',
  title,
  count,
  unit = 'items',
  children,
}: {
  active?: 'feed' | 'sources';
  title: string;
  count: number | undefined;
  unit?: string;
  children?: ReactNode;
}) {
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  // Polls run in the background on the server; refresh twice as they land.
  const resyncAll = async () => {
    setResyncing(true);
    try {
      const { polling } = await unwrap(BlyggerApi.pollAllSubscriptions({ client }));
      toast(`Checking ${polling} feed${polling === 1 ? '' : 's'}…`);
      for (const wait of [6000, 20000]) setTimeout(() => void changed('reading', 'subscriptions'), wait);
    } catch {
      toast('Could not start the resync. Try again in a moment.');
    } finally {
      setTimeout(() => setResyncing(false), 6000);
    }
  };
  return (
    <>
      <ReadingTabs active={active} />
      <div className="view-head">
        <h2 className="view-h">
          {title}
          <small>{count !== undefined ? `${count} ${unit}` : '\u00a0'}</small>
        </h2>
        <div className="view-actions">
          {children}
          <Button
            className="icon-btn"
            aria-label="resync all feeds"
            title="resync all feeds"
            disabled={resyncing}
            onClick={() => void resyncAll()}
          >
            ↻
          </Button>
          <Button
            className="icon-btn"
            aria-label="subscribe"
            title="subscribe"
            onClick={() => setAdding(true)}
          >
            ＋
          </Button>
        </div>
      </div>
      <SubscribeSheet open={adding} onClose={() => setAdding(false)} onImport={() => setImporting(true)} />
      <OpmlImportSheet open={importing} onClose={() => setImporting(false)} />
    </>
  );
}
/**
 * Read state on a timeline: unread dots, mark-read-on-open, select mode with
 * mark read / mark unread for the ticked rows, and "mark all read" for the
 * whole view — every page of this source under this lens, not only the page
 * on screen, sent in batches of at most 500.
 */
function useReadSelection(key: string, offset: number, entries: Reading[], actions: Actions, title: string, lens: Lens) {
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  // A selection belongs to the rows on screen; a new page or view starts clean.
  useEffect(() => setPicked(new Set()), [key, offset]);
  const stop = () => {
    setSelecting(false);
    setPicked(new Set());
  };
  const ui = useMemo<ReadUi>(
    () => ({
      shown: true,
      selecting,
      selected: picked,
      toggle: (entryKey) =>
        setPicked((current) => {
          const next = new Set(current);
          if (!next.delete(entryKey)) next.add(entryKey);
          return next;
        }),
      opened: (entry) => {
        if (needsRead(readStatus(entry.imported))) void actions.run(() => markEntries([entry], true));
      },
    }),
    [selecting, picked, key, actions],
  );
  const importedRows = entries.filter((entry) => entry.imported);
  const apply = (read: boolean) => {
    const chosen = importedRows.filter((entry) => picked.has(entry.key));
    stop();
    if (chosen.length) void actions.run(() => markEntries(chosen, read));
  };
  const markAll = () =>
    actions.run(async () => {
      const [sub, kind] = key.split('~') as [string, 'thread' | 'fragment' | undefined];
      const rows: Markable[] = [];
      for (let at = 0; ; at += 50) {
        const page = await unwrap(BlyggerApi.listReading({ client, query: { sub, offset: at, limit: 50, ...(kind ? { kind } : {}) } }));
        rows.push(...page.items);
        if (!page.items.length || at + page.items.length >= page.total) break;
      }
      const unread = rows.filter((entry) => needsRead(readStatus(entry.imported)));
      if (!unread.length) {
        toast('nothing unread here');
        return;
      }
      const n = unread.length;
      const ok = await confirm({
        title: `Mark ${n} item${n === 1 ? '' : 's'} read?`,
        body: `Every unread entry in “${title}”${lens === 'all' ? '' : ` (${LENS_LABELS[lens]})`}, on every page.`,
        ok: 'mark read',
      });
      if (!ok) return;
      stop();
      await markEntries(unread, true);
      toast(`marked ${n} read`);
    });
  const openMenu = () =>
    void menu({
      title: 'read state',
      rows: [
        selecting
          ? { icon: '✕', label: 'stop selecting', onSelect: stop }
          : { icon: '☑', label: 'select…', onSelect: () => setSelecting(true) },
        { icon: '✓', label: 'mark all read…', onSelect: () => void markAll() },
      ],
    });
  const button = (
    <Button
      className="icon-btn"
      aria-label="read state"
      title="select, mark read or unread"
      aria-pressed={selecting}
      onClick={openMenu}
    >
      ☑
    </Button>
  );
  const allPicked = importedRows.length > 0 && importedRows.every((entry) => picked.has(entry.key));
  const bar = selecting ? (
    <>
      <div className="select-spacer" aria-hidden="true" />
      <div className="select-bar" role="toolbar" aria-label="selection">
        <span className="state">{picked.size} selected</span>
        <Button
          className="btn btn-ghost btn-mini"
          aria-label={allPicked ? 'select none' : 'select all on this page'}
          onClick={() => setPicked(allPicked ? new Set() : new Set(importedRows.map((entry) => entry.key)))}
        >
          {allPicked ? 'none' : 'all'}
        </Button>
        <Button className="btn btn-primary btn-mini" disabled={!picked.size} onClick={() => apply(true)}>
          mark read
        </Button>
        <Button className="btn btn-ghost btn-mini" disabled={!picked.size} onClick={() => apply(false)}>
          mark unread
        </Button>
        <Button className="btn btn-ghost btn-mini" onClick={stop}>
          done
        </Button>
      </div>
    </>
  ) : null;
  return { ui, button, bar };
}
function Timeline({ sub, offset }: { sub: string; offset: number }) {
  const lensSearch = useLensSearch();
  useChrome({ framed: false, wide: false });
  const actions = useReadingActions();
  const [inspecting, setInspecting] = useState(false);
  const lens = useContext(LensContext);
  const key = readingKey(sub, lens);
  const entries = useLiveQuery(readingView(key, offset));
  const sources =
    useLiveQuery({ query: (q) => q.from({ source: subscriptions }) }).data ??
    [];
  const metadata = readingMeta(key, offset);
  const selected = sources.find((source) => source.id === sub);
  const title =
    sub === 'all'
      ? 'all'
      : sub === 'own'
        ? 'my blyg'
        : selected
          ? sourceName(selected)
          : 'all';
  const readable = sub !== 'own' && !isPlaceholder(lens);
  useReturnPoint(!!entries.data?.length);
  const read = useReadSelection(key, offset, entries.data ?? [], actions, title, lens);
  return (
    <ReadContext.Provider value={read.ui}>
      <ReadingHead title={title} count={metadata?.total}>
        {readable ? read.button : null}
        {selected ? (
          <Button
            className="icon-btn"
            aria-label="about this source"
            onClick={() => setInspecting(true)}
          >
            ⓘ
          </Button>
        ) : null}
      </ReadingHead>
      <LensBar sub={sub} />
      <Failure error={actions.error} />
      {selected?.status === 'paused' ? (
        <div className="banner banner-warn" role="note">
          <span className="mark" aria-hidden="true">
            ‖
          </span>
          <div className="body">Paused — not polled until you resume it.</div>
        </div>
      ) : null}
      {isPlaceholder(lens) ? (
        <LensPlaceholder />
      ) : (
        <>
          {lens === 'background' ? <p className="view-sub">{BACKGROUND_NOTE}</p> : null}
          {entries.isLoading ? <p className="view-sub">Loading reading…</p> : null}
          <EntryList entries={entries.data ?? []} actions={actions} />
          {!entries.isLoading && !entries.data?.length ? (
            <div className="empty">
              <span className="em" aria-hidden="true">
                ◫
              </span>
              {lens === 'background' ? 'Nothing withdrawn.' : 'No items yet.'}
            </div>
          ) : null}
          <Pager
            offset={offset}
            total={metadata?.total}
            go={(next) =>
              void actions.navigate({
                to: '/reading',
                search: { sub, offset: next, ...lensSearch },
              })
            }
          />
          {readable ? read.bar : null}
        </>
      )}
      <Inspector
        source={inspecting ? selected : undefined}
        count={metadata?.total}
        onClose={() => setInspecting(false)}
        actions={actions}
        onDeleted={() =>
          void actions.navigate({ to: '/reading', search: { view: 'sources' } })
        }
      />
    </ReadContext.Provider>
  );
}
/** A hopper member as a reading entry, so it gets every entry action. */
function hopperEntry(
  item: ImportedItem,
  source: Subscription | undefined,
  rank: number,
): Reading {
  const withdrawn = item.state === 'tombstone';
  const displayAt =
    item.updated && Date.parse(item.updated) < Date.parse(item.observed_at)
      ? item.updated
      : item.observed_at;
  return {
    key: `imported:${JSON.stringify([item.subscription_id, item.remote_id])}`,
    source: 'imported',
    kind: item.kind,
    withdrawn,
    l0: item.l0,
    contentHtml: item.content_html,
    displayAt,
    rank,
    imported: {
      subscriptionId: item.subscription_id,
      subscriptionTitle: source ? sourceName(source) : item.subscription_id,
      remoteId: item.remote_id,
      kind: item.kind,
      withdrawn,
      l0: item.l0,
      updated: item.updated,
      observedAt: item.observed_at,
      contentHtml: item.content_html,
      pinnedVersionRetained: item.pinned_version_retained,
      sourceUrl: source
        ? sourceTitleAndUrl({ ...item, l0: item.l0 ? 1 : 0 }, source.origin)
            .url
        : null,
      version: item.version,
      // Hopper detail reads the stored import, which carries no read state,
      // so a hopper shows none (HOPPER_READ); opening an entry still marks it.
      readVersion: null,
    },
  };
}
/** Hoppers show no read state; opening a member still stores the read. */
const HOPPER_READ: ReadUi = {
  shown: false,
  selecting: false,
  selected: new Set(),
  toggle: () => {},
  opened: (entry) => void markEntries([entry], true).catch(() => toast('Could not store the read mark.')),
};
function HopperTimeline({ id, offset }: { id: string; offset: number }) {
  const lensSearch = useLensSearch();
  useChrome({ framed: false, wide: false });
  const actions = useReadingActions();
  const collection = useMemo(() => hopperDetail(id), [id]);
  const result = useLiveQuery({ query: (q) => q.from({ hopper: collection }) });
  const row = result.data?.[0];
  const sources =
    useLiveQuery({ query: (q) => q.from({ source: subscriptions }) }).data ??
    [];
  const lens = useContext(LensContext);
  const kind = lensKind(lens);
  const entries = useMemo(
    () =>
      (row?.items ?? [])
        .filter((item) => !kind || item.kind === kind)
        .map((item, i) =>
          hopperEntry(
            item,
            sources.find((source) => source.id === item.subscription_id),
            i,
          ),
        )
        // Withdrawn members are background, as in the feed.
        .filter((entry) => !!entry.withdrawn === (lens === 'background')),
    [row, sources, kind, lens],
  );
  useReturnPoint(entries.length > 0);
  if (!row)
    return (
      <>
        <ReadingHead title="hopper" count={undefined} />
        <LensBar hopper={id} />
        <p className="view-sub" role={result.isReady ? 'alert' : undefined}>
          {result.isReady ? 'Hopper not found.' : 'Loading hopper…'}
        </p>
      </>
    );
  const start = offset < entries.length ? offset : 0;
  return (
    <>
      <ReadingHead title={row.hopper.name} count={kind ? entries.length : row.total}>
        <Link
          className="btn btn-ghost btn-mini"
          to="/hoppers/$id"
          params={{ id }}
        >
          manage
        </Link>
      </ReadingHead>
      <LensBar hopper={id} />
      <Failure error={actions.error} />
      {isPlaceholder(lens) ? (
        <LensPlaceholder />
      ) : (
        <>
      <ReadContext.Provider value={HOPPER_READ}>
        <EntryList
          entries={entries.slice(start, start + PAGE)}
          actions={actions}
        />
      </ReadContext.Provider>
      {!entries.length ? (
        <div className="empty">
          <span className="em" aria-hidden="true">
            ▤
          </span>
          No items yet.
        </div>
      ) : (
        <Pager
          offset={start}
          total={entries.length}
          go={(next) =>
            void actions.navigate({
              to: '/reading',
              search: { hopper: id, offset: next, ...lensSearch },
            })
          }
        />
      )}
        </>
      )}
    </>
  );
}

export function ReadingPage({
  sub,
  hopper,
  offset,
  lens = 'all',
  view,
}: {
  sub?: string;
  hopper?: string;
  offset?: number;
  lens?: Lens;
  view?: 'sources';
}) {
  // A timeline or source list is where a walk through the thicket ends.
  useEndTrail();
  return (
    <LensContext.Provider value={lens}>
      {view === 'sources' ? (
        <Sources />
      ) : hopper ? (
        <HopperTimeline id={hopper} offset={offset ?? 0} />
      ) : (
        <Timeline sub={sub ?? 'all'} offset={offset ?? 0} />
      )}
    </LensContext.Provider>
  );
}

/* ---------------- imported history (#40) ---------------- */

type ImportedHistory = Awaited<ReturnType<typeof loadHistory>>;
const loadHistory = (sub: string, id: string) =>
  unwrap(BlyggerApi.getImportedHistory({ client, path: { sub, id } }));
const loadVersion = (sub: string, id: string, v: number) =>
  unwrap(BlyggerApi.getImportedVersion({ client, path: { sub, id, v } }));
/**
 * An imported item's history (#40): its notes as a timeline, read from the
 * origin, and "see the change" only between versions the origin serves
 * publicly — adjacent pins, and the last pin against the current version.
 * Unpinned history is withheld at the source; nothing here offers it.
 * Opened and closed from the entry's ⋯ sheet ("history" / "hide history").
 */
function History({ sub, id }: { sub: string; id: string }) {
  const [history, setHistory] = useState<ImportedHistory>();
  const [diff, setDiff] = useState<{ from: number; to: number; ops: DiffOp[] }>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const settings = useSettings();
  const when = (iso: string) =>
    iso ? formatDateIn(iso, settings?.timezone || 'UTC') : '';
  useEffect(() => {
    let live = true;
    loadHistory(sub, id).then(
      (loaded) => live && setHistory(loaded),
      (failure) => live && setError(failure),
    );
    return () => {
      live = false;
    };
  }, [sub, id]);
  const compare = async (from: number, to: number) => {
    setBusy(true);
    setError(undefined);
    try {
      const [a, b] = await Promise.all([
        loadVersion(sub, id, from),
        loadVersion(sub, id, to),
      ]);
      setDiff({ from, to, ops: diffText(a.content_md, b.content_md) });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  // The versions whose text is public, in order: every pin, then the current
  // version unless the item is withdrawn.
  const publicVersions = history
    ? [
        ...new Set([
          ...history.changelog.filter((e) => e.pinned).map((e) => e.version),
          ...(history.withdrawn ? [] : [history.current]),
        ]),
      ].sort((a, b) => a - b)
    : [];
  const previousPublic = (v: number) => {
    const i = publicVersions.indexOf(v);
    return i > 0 ? publicVersions[i - 1] : undefined;
  };
  return (
    <div className="entry-history" aria-label="history">
      <Failure error={error} />
      {history ? (
        <ol className="h-list">
          {history.changelog.map((e) => {
            const prev = previousPublic(e.version);
            return (
              <li className="h-row" key={e.version}>
                <span className="vnum">v{e.version}</span>
                <span className="h-hint">{when(e.at)}</span>
                <span>{e.note ?? <span className="h-hint">(no note)</span>}</span>
                {e.generated ? (
                  <span
                    className="badge tc-chip"
                    title="note drafted by the publisher's studio"
                  >
                    generated
                  </span>
                ) : null}
                {e.pinned ? (
                  <span className="badge badge-pencil tc-chip">📌 pinned</span>
                ) : null}
                {prev !== undefined ? (
                  <Button
                    className="more"
                    data-action="see-change"
                    disabled={busy}
                    onClick={() => void compare(prev, e.version)}
                  >
                    see the change v{prev} → v{e.version}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : !error ? (
        <p className="h-hint">Loading history from the origin…</p>
      ) : null}
      {diff ? (
        <div
          className="entry-diff"
          aria-label={`changes from v${diff.from} to v${diff.to}`}
        >
          <p className="h-hint">
            v{diff.from} → v{diff.to}, as published (markdown source)
          </p>
          <pre>
            {diff.ops.map((op, i) =>
              op.op === 'eq' ? (
                <span key={i}>{op.text}</span>
              ) : op.op === 'del' ? (
                <del key={i}>{op.text}</del>
              ) : (
                <ins key={i}>{op.text}</ins>
              ),
            )}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
