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
import { createItem, createHopper, addHopperItem, resyncSubscription, pollSubscriptions, markUnheldRead, setReadingPlacement, setBlygBackground } from './server-mutations.ts';
import { readingPage } from '../paging.ts';
import { linkSource } from '../grammar.ts';
import { linkLabel } from '../link-label.ts';
import type { ReactNode } from 'react';
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from '@tanstack/react-db';
import { Link, useNavigate } from '@tanstack/react-router';
import type {
  CreateItemData,
  Hopper,
  ImportedItem,
  Signal,
  Subscription,
} from '../../sdk/dist/browser.js';
import { BlyggerApi, unwrap } from '../../sdk/dist/browser.js';
import type { Lens, Reading } from './data.ts';
import { FEED_LENSES, READING_TABS, readingKey, settings as settingsCollection } from './data.ts';
import {
  reading,
  readingView,
  subscriptions,
  hoppers,
  signals,
  client,
  setThumb,
  queryClient,
  readingSummaryView,
  readAllReading,
  hopperInfo,
  markReading,
} from './data.ts';
import { needsRead, readStatus, readWrites } from './read-state.ts';
import {
  Button,
  Failure,
  mount,
  useChrome,
  useSettings,
  SourceLink,
  CopiesElsewhere,
} from './components.tsx';
import { Toggle, ToggleGroup } from './buttons.tsx';
import { Tab, Tabs } from './primitives.tsx';
import { Sheet, confirm, menu, prompt, toast } from './sheets.tsx';
import { IconButton, Tooltip } from './primitives.tsx';
import { shelfLabel, toggleShelf, useShelf } from './shelf.tsx';
import { SourceName } from './source-name.tsx';
import { AgenticFeed } from './agentic.tsx';
import { hasQuotes, openCatchUp } from './catch-up.tsx';
import { displayUrl, sourceTitleAndUrl } from '../importer/util.ts';
import { ReaderBody, TrailBar, ownOrigin, useEndTrail, useSubscriptionRows } from './reader-links.tsx';
import { currentTrail, visit } from './browse.ts';
import { formatDateIn } from '../dates.ts';
import { AddFeedForm } from './catalog.tsx';
import { OpmlImportSheet } from './opml-import.tsx';
import { DiscoverSheet } from './discover.tsx';
import { diffText, type DiffOp } from '../word-diff.ts';
import { useSwipe } from './swipe.ts';
import type { EntryContext, StudioExtension } from './extension-api.ts';
import { EntryBylineSlot, EntrySheetSlot, entryActionRows, enabledExtensions, type HostContext, type OpenSheet } from './extensions.tsx';
import { compiledExtensions } from '../../build/extensions.ui.ts';
import { More, ThumbDown, ThumbUp } from './icons.tsx';
import { SearchBox, SearchResults, type SearchFilters } from './search.tsx';
import { addAuthorContact } from './contacts.tsx';
import { markOwnMentions, useOwnMentionTargets } from './own-mentions.ts';
import './reading.css';


const PAGE = 25;

/* ---------------- small helpers ---------------- */

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
  const polled = source.lastPollAt
    ? `last polled ${pollTime(source.lastPollAt, timeZone)}`
    : 'never polled';
  if (source.status === 'paused') return { text: 'paused', bad: false };
  if (source.failCount > 0)
    return { text: `${source.failCount} failures · ${polled}`, bad: true };
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
    const created = await createItem(body);
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
  /** Seen-means-read: a card registers itself here while it is mounted. */
  watch?: (card: HTMLElement) => () => void;
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
  const self = useOwnMentionTargets();
  const lens = useContext(LensContext);
  useLayoutEffect(() => {
    const element = body.current;
    const first = element && markOwnMentions(element, self);
    if (!element || !first || lens !== 'mentions') return;
    // The mention may sit below the clamp: bring it into the part the card shows,
    // and again whenever the text reflows (a late font, a loaded image, a resize).
    const focus = () => {
      element.scrollTop = Math.max(0, first.offsetTop - element.clientHeight / 3);
    };
    focus();
    const observer = new ResizeObserver(focus);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [content.html, self, lens]);
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
// A draft (only the hopper lens lists one) has no version yet: a link, quote or fork of it fails at publish.
function canLink(entry: Reading) {
  return (
    !entry.l0 &&
    (entry.own
      ? !entry.withdrawn && !entry.own.draft
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
  // A private item has no public page (decision #94), and a draft none yet, so no link to one.
  const url = entry.own
    ? !entry.withdrawn && !entry.own.private && !entry.own.draft
      ? `${location.origin}${mount}/${entry.kind === 'thread' ? 't' : 'f'}/${id}/`
      : undefined
    : imported?.sourceUrl || undefined;
  // Own items are stubbed as hoppers address them, `~own` (session 50).
  const source = imported
    ? { subscriptionId: imported.subscriptionId, remoteId: imported.remoteId }
    : entry.own
      ? { subscriptionId: OWN_SUB, remoteId: entry.own.id }
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
  votes: Signal[];
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
      vote.subscriptionId === imported?.subscriptionId &&
      vote.remoteId === imported?.remoteId,
  );
  const vote = (thumb: 1 | -1) =>
    run(async () => {
      if (!imported) return;
      await setThumb({
        sub: imported.subscriptionId,
        remoteId: id,
        thumb: signal?.thumb === thumb ? null : thumb,
      }).when('settled');
    });
  const stub = () =>
    source ? run(() => openDraft({ mode: 'response', source })) : undefined;
  const linkPost = () =>
    void run(() => openDraft({ contentMd: `[[${id}]]\n\n`, kind: 'fragment' }));
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
  const extensionContext = (extension: StudioExtension): HostContext<EntryContext> => ({
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
  // The shelf keeps only what resolves (src/shelf.ts): never a withdrawn own item, nor a tombstone without its pin.
  const shelved = useShelf();
  const shelfEntry = hopperSub && (!entry.withdrawn || imported?.pinnedVersionRetained != null) ? { sub: hopperSub, remoteId: id } : null;
  const shelf = shelfEntry
    ? { label: shelfLabel(shelved, shelfEntry), on: shelfLabel(shelved, shelfEntry) === 'remove from saved', toggle: () => run(() => toggleShelf(shelved, shelfEntry)) }
    : null;
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
        const hopper = await createHopper(typed);
        hopperId = hopper.id;
        name = hopper.name;
      }
      await addHopperItem({ id: hopperId, sub: hopperSub, remoteId: id });
      toast(`added to ${name}`);
    });
  // Background and Foreground (src/background.ts): a view preference, not a
  // judgement, so nothing here is logged as an interaction or marks anything read.
  const inBackground = useContext(LensContext) === 'background';
  const place = (placement: 'background' | 'foreground' | null) =>
    run(async () => {
      await setReadingPlacement({ source: imported ? 'imported' : 'own', ...(imported ? { sub: imported.subscriptionId } : {}), id, placement });
      toast(placement === 'background' ? 'moved to Background' : placement === 'foreground' ? 'moved to Foreground' : 'the rules decide again');
    });
  const blygBackground = (background: boolean) =>
    run(async () => {
      if (!imported) return;
      await setBlygBackground({ id: imported.subscriptionId, background });
      toast(`${imported.subscriptionTitle} ${background ? 'moved to Background' : 'back in the main lenses'}`);
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
        hasQuotes(entry.contentHtml) && (imported || entry.own) && {
          key: 'catch-up',
          icon: '⇣',
          label: 'catch up',
          description: 'the conversation it carries, oldest first',
          onSelect: () => void openCatchUp(imported ? imported.subscriptionId : '~own', imported ? imported.remoteId : entry.own!.id),
        },
        !!imported &&
          !entry.l0 && {
            key: 'history',
            icon: '⟲',
            label: historyOpen ? 'hide history' : 'history',
            onSelect: () => setHistoryOpen((open) => !open),
          },
        !!imported && {
          key: 'add-author',
          icon: '@',
          label: 'add author to address book',
          onSelect: () => void authorSeed(imported).then(addAuthorContact),
        },
        // Only a published item can be placed (setReadingPlacement), so not a draft.
        (imported || (entry.own && !entry.own.draft)) && {
          key: 'placement',
          icon: inBackground ? '↑' : '↓',
          label: inBackground ? 'move to Foreground' : 'move to Background',
          onSelect: () => void place(inBackground ? 'foreground' : 'background'),
        },
        entry.background.placement !== null && {
          key: 'placement-clear',
          icon: '↺',
          label: 'clear my choice',
          description: 'Background and Foreground follow the rules again',
          onSelect: () => void place(null),
        },
        !!imported && {
          key: 'blyg-placement',
          icon: entry.background.blyg ? '⇈' : '⇊',
          label: entry.background.blyg ? 'move this blyg to Foreground' : 'move this blyg to Background',
          onSelect: () => void blygBackground(!entry.background.blyg),
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
    shelf,
    openMenu,
    historyOpen,
    extensions,
    extensionContext,
    extensionSheet,
    closeExtensionSheet: () => setExtensionSheet(null),
  };
}
type EntryActions = ReturnType<typeof useEntryActions>;

/**
 * Who wrote an imported entry, as far as it says. A reading row does not carry
 * its author, so this reads the item when asked. An rss subscription's origin is
 * its feed, so it falls back to the site.
 */
async function authorSeed(imported: NonNullable<Reading['imported']>) {
  const item = await unwrap(BlyggerApi.getImportedItem({ client, path: { sub: imported.subscriptionId, id: imported.remoteId } })).catch(() => null);
  const author = (item?.author ?? {}) as { name?: unknown; url?: unknown };
  const origin = subscriptions.get(imported.subscriptionId)?.origin ?? imported.sourceUrl ?? '';
  const site = imported.l0 && origin ? new URL(origin).origin + '/' : origin;
  return {
    name: typeof author.name === 'string' && author.name ? author.name : imported.subscriptionTitle,
    url: typeof author.url === 'string' && author.url.startsWith('https:') ? author.url : site,
  };
}

/**
 * Why an entry is in Background, in the plan's precedence (background-plan.md
 * §4): your choice on it, then on its blyg, then the first rule that applies.
 */
function backgroundLabel(entry: Reading): string | null {
  const { placement, blyg, reasons, detail } = entry.background;
  if (placement === 'background') return 'you moved this';
  if (blyg) return 'blyg in Background';
  // Withdrawn entries already say so under the body (Tomb).
  if (reasons[0] === 'withdrawn') return null;
  if (reasons[0] === 'burst') return 'part of a burst';
  if (reasons[0] === 'wordless') return 'no words of its own';
  if (reasons[0] === 'maintenance') return 'republished unchanged';
  if (reasons[0] === 'quotes-refreshed') return 'quotes refreshed';
  if (reasons[0] === 'quotes-material') return 'quotes refreshed (rewritten)';
  if (reasons[0] === 'near-same') return 'small edit';
  if (reasons[0] === 'minor') {
    // Own items carry the category at the top (4a); imported ones under `classify` (4b).
    const classify = detail?.classify as { category?: unknown; instructed?: unknown } | undefined;
    const category = detail?.category ?? classify?.category;
    const by = classify?.instructed ? ', by your instruction' : '';
    return typeof category === 'string' ? `minor change (${category}${by})` : 'minor change';
  }
  if (reasons[0] === 'superseded') return 'followed within 15 min';
  return null;
}

/**
 * A note that claims a small change against a large measured one (Background
 * 4b under the owner's routing instruction, #96): shown in every lens, since
 * the entry stays in view because of it.
 */
function disagreementLabel(entry: Reading): string | null {
  const d = (entry.background.detail?.classify as { disagree?: { note?: unknown; changed?: unknown } } | undefined)?.disagree;
  return d && typeof d.note === 'string' && typeof d.changed === 'number' ? `note says ${d.note} · ${d.changed}% changed` : null;
}

/**
 * The byline: kind, legacy rss, source and date, plus the extensions' slot.
 * With `onOpen`, the date links to the entry's full view, short entries
 * included (the web's permalink convention, decision #71); opening it marks
 * the entry read like "more" does.
 */
function Byline({ entry, a, onOpen, children }: { entry: Reading; a: EntryActions; onOpen?: () => void; children?: ReactNode }) {
  const settings = useSettings();
  const date = formatDateIn(entry.displayAt, settings?.timezone || 'UTC');
  const inBackground = useContext(LensContext) === 'background';
  const lensSearch = useLensSearch();
  const why = inBackground ? backgroundLabel(entry) : disagreementLabel(entry);
  return (
    <p className="byline">
      {children}
      <span className="badge">{entry.kind}</span>
      {entry.own?.private ? <span className="badge badge-line" title="only you can see this">private</span> : null}
      {entry.own?.draft ? <span className="badge badge-line" title="not published yet">draft</span> : null}
      {entry.l0 ? <span className="badge badge-line">legacy rss</span> : null}
      {why ? <span className="badge badge-line badge-why" title={inBackground ? 'why this is in Background' : 'kept in view: the note claims a smaller change than was made'}>{why}</span> : null}
      <SourceName entry={entry} lens={lensSearch} />
      <span>
        ·{' '}
        {onOpen ? (
          <Link
            className="entry-date"
            to="/reading/$sub/$id"
            params={articleParams(entry)}
            title="open this entry"
            // Not draggable, like SourceName: a mouse swipe starts from the byline (swipe.ts).
            draggable={false}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
              event.preventDefault();
              onOpen();
            }}
          >
            {date}
          </Link>
        ) : (
          date
        )}
      </span>
      <EntryBylineSlot extensions={a.extensions} context={a.extensionContext} />
    </p>
  );
}
/**
 * A thread published with its parts (spec §13.7's fold): the parts wait in
 * Background as `burst`, and the thread lists them here, folded until opened.
 */
function BurstParts({ entry, open = false }: { entry: Reading; open?: boolean }) {
  const [shown, setShown] = useState(open);
  const parts = entry.parts ?? [];
  if (!parts.length) return null;
  return (
    <div className="burst-parts" data-parts={parts.length}>
      <Button className="link-btn burst-toggle" aria-expanded={shown} onClick={() => setShown(!shown)}>
        {shown ? '−' : '+'}{parts.length} {parts.length === 1 ? 'part' : 'parts'}
      </Button>
      {shown ? (
        <ol className="burst-list">
          {parts.map((part) => (
            <li key={`${part.sub}/${part.id}`}>
              <Link to="/reading/$sub/$id" params={{ sub: part.sub, id: part.id }}>
                {part.label || part.id.slice(0, 8)}
              </Link>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
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
            <Tooltip key={thumb} label={thumb === 1 ? 'thumbs up' : 'thumbs down'}>
              <Button
                className="act icon-only thumb"
                aria-label={thumb === 1 ? 'thumbs up' : 'thumbs down'}
                aria-pressed={signal?.thumb === thumb}
                onClick={() => void a.vote(thumb)}
              >
                {thumb === 1 ? <ThumbUp /> : <ThumbDown />}
              </Button>
            </Tooltip>
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
          {entry.own?.private || entry.own?.draft ? null : <Button
            className="act"
            data-action="stub"
            data-sub={imported?.subscriptionId ?? OWN_SUB}
            data-remote={id}
            onClick={() => void a.stub()}
          >
            stub ↗
          </Button>}
          <Button
            className="act"
            aria-label="add to hopper"
            onClick={() => void a.addToHopper()}
          >
            + <span className="act-wide">add to </span>hopper…
          </Button>
        </>
      ) : null}
      {a.shelf ? (
        <Button className="act" data-action="shelf" aria-label={a.shelf.label} onClick={() => void a.shelf?.toggle()}>
          {a.shelf.on ? '✓ saved' : '+ save'}
        </Button>
      ) : null}
      <Tooltip label="more actions">
        <Button
          className="act icon-only more-btn"
          aria-label="more actions"
          // Keep a text selection alive through the press.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void a.openMenu()}
        >
          <More />
        </Button>
      </Tooltip>
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
  votes: Signal[];
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
        ref={imported && readUi.watch ? readUi.watch : undefined}
        className={`entry reading-entry${status ? ` is-${status}` : ''}`}
        data-private={entry.own?.private ? '' : undefined}
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
          <Byline entry={entry} a={a} onOpen={openArticle}>
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
          <CopiesElsewhere entries={imported?.syndication} />
          <BurstParts entry={entry} />
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

type LogEntry = { version: number; at: string; note: string | null; pinned: boolean };
type Changelog = { current: number; entries: LogEntry[] };

// One read per item and version, kept for the session; failures are not kept.
const changelogs = new Map<string, Promise<Changelog>>();
function loadChangelog(entry: Reading): Promise<Changelog> {
  const imported = entry.imported;
  const key = imported
    ? JSON.stringify(['imp', imported.subscriptionId, imported.remoteId, imported.version])
    : JSON.stringify(['own', entry.own!.id, entry.own!.updated]);
  let got = changelogs.get(key);
  if (!got) {
    got = imported
      ? loadHistory(imported.subscriptionId, imported.remoteId).then((h) => ({
          current: h.current,
          entries: h.changelog.map(({ version, at, note, pinned }) => ({ version, at, note, pinned })),
        }))
      : unwrap(BlyggerApi.listItemVersions({ client, path: { id: entry.own!.id }, query: { limit: 100 } })).then((page) => {
          const entries = page.items
            .filter((v) => v.kind !== 'withdrawn')
            .map((v) => ({ version: v.version, at: v.publishedAt, note: v.note, pinned: v.pinned }))
            .sort((a, b) => a.version - b.version);
          return { current: entries.at(-1)?.version ?? 0, entries };
        });
    got.catch(() => changelogs.delete(key));
    changelogs.set(key, got);
  }
  return got;
}
const meaningfulLog = (entries: LogEntry[]) => entries.length > 1 || entries.some((e) => !!e.note?.trim());

/** Every note, newest first; on a card the newest three and a count of the rest. */
function ChangeHistory({ entries, limit }: { entries: LogEntry[]; limit?: number }) {
  const settings = useSettings();
  const newest = [...entries].reverse();
  const shown = limit ? newest.slice(0, limit) : newest;
  return (
    <ol className="change-history" data-change-history>
      {shown.map((e) => (
        <li key={e.version}>
          <strong>V{e.version}</strong>
          {Number.isNaN(Date.parse(e.at)) ? null : <span className="h-hint"> {formatDateIn(e.at, settings?.timezone || 'UTC')}</span>}:{' '}
          {e.note?.trim() || <span className="h-hint">no note</span>}
          {e.pinned ? <span className="h-hint"> · pinned</span> : null}
        </li>
      ))}
      {shown.length < newest.length ? (
        <li className="h-hint">and {newest.length - shown.length} earlier, in history</li>
      ) : null}
    </ol>
  );
}

/**
 * The changelog above an entry's body, as Settings' reader_changelog_display
 * asks (session 61): the latest note ("V3: note"), every note, or an AI
 * summary. Read from the item's changelog once the entry is on screen: an
 * imported item's from its origin (the importer keeps the latest state, not
 * the changelog), an own item's from its versions. A summary is asked for
 * only when the item is opened, and kept per version on the server; a card in
 * summary mode shows the latest note meanwhile. Only blyg-native, live items
 * have one, and an item whose changelog says nothing beyond its first version
 * shows none.
 */
function ChangeLead({ entry, opened = false }: { entry: Reading; opened?: boolean }) {
  const settings = useSettings();
  const mode = settings?.readerChangelogDisplay ?? 'latest';
  const imported = entry.imported;
  const version = imported?.version ?? 0;
  // The latest note is what the reader showed before session 61, imported items only.
  const eligible = !entry.l0 && !entry.withdrawn && (imported ? mode !== 'latest' || version > 1 : mode !== 'latest' && !!entry.own);
  const line = useRef<HTMLDivElement>(null);
  const [log, setLog] = useState<Changelog | null | undefined>();
  const [summary, setSummary] = useState<{ text?: string; model?: string; error?: string } | undefined>();
  useEffect(() => {
    setLog(undefined);
    setSummary(undefined);
    const element = line.current;
    if (!eligible || !element) return;
    let live = true;
    const load = () => {
      loadChangelog(entry).then(
        (value) => live && setLog(value),
        () => live && setLog(null),
      );
      if (opened && mode === 'summary') {
        const body = imported ? { subscriptionId: imported.subscriptionId, remoteId: imported.remoteId } : { itemId: entry.own!.id };
        unwrap(BlyggerApi.summarizeChangelog({ client, body })).then(
          (r) => live && setSummary({ text: r.summary, model: r.model }),
          (e) => live && setSummary({ error: e instanceof Error ? e.message : String(e) }),
        );
      }
    };
    // Only entries that come on screen read a changelog.
    const observer = new IntersectionObserver((seen) => {
      if (!seen.some((s) => s.isIntersecting)) return;
      observer.disconnect();
      load();
    });
    observer.observe(element);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [entry.key, version, eligible, mode, opened]);
  if (!eligible) return null;
  const latest = log?.entries.find((e) => e.version === (imported ? version : log.current));
  const latestLine = (
    <p className={`change-lead${log === null || (log && !latest?.note?.trim()) ? ' none' : ''}`} data-change-lead>
      <strong>V{imported ? version : log?.current ?? ''}:</strong>{' '}
      {log === undefined ? '…' : latest?.note?.trim() || 'No changelog entry available'}
    </p>
  );
  let body: ReactNode = null;
  if (log === undefined) body = mode === 'latest' ? latestLine : <p className="change-lead none" data-change-lead>…</p>;
  else if (mode === 'latest') body = latestLine;
  else if (!log || !meaningfulLog(log.entries)) body = null;
  else if (mode === 'history' || (mode === 'summary' && !opened)) body = mode === 'history' ? <ChangeHistory entries={log.entries} limit={opened ? undefined : 3} /> : latestLine;
  else if (summary?.text) {
    body = (
      <p className="change-lead change-summary" data-change-summary>
        <strong>Changes so far</strong>{' '}
        <span className="badge tc-chip" title={`written by ${summary.model || 'a model'} from the changelog notes; not the author's words`}>
          AI summary
        </span>{' '}
        {summary.text}
      </p>
    );
  } else {
    body = (
      <>
        <p className="change-lead none" data-change-summary>
          {summary?.error ? `No summary: ${summary.error}` : 'Summarizing the changelog…'}
        </p>
        <ChangeHistory entries={log.entries} />
      </>
    );
  }
  return (
    <div ref={line} className="change-log">
      {body}
    </div>
  );
}

/** An own item as a reading entry, for a full view opened by its address. */
async function ownEntry(id: string, signal?: AbortSignal): Promise<Reading> {
  const item = await unwrap(BlyggerApi.getItem({ client, path: { id }, signal }));
  const withdrawn = item.status === 'withdrawn';
  // A private item has no public version; its latest private version stands in, as in the list.
  const isPrivate = item.status === 'private';
  const kept = isPrivate ? (await unwrap(BlyggerApi.listPrivateVersions({ client, path: { id }, query: { limit: 1 }, signal }))).items[0] : undefined;
  const contentHtml = withdrawn ? '' : isPrivate ? (kept?.contentHtml ?? '') : (item.published?.contentHtml ?? '');
  const kind = item.kind;
  return {
    key: `own:${id}`,
    source: 'own',
    kind,
    withdrawn,
    l0: false,
    contentHtml,
    displayAt: item.published?.publishedAt ?? kept?.publishedAt ?? item.updated,
    rank: 0,
    own: { id, kind, withdrawn, updated: item.updated, contentHtml, ...(isPrivate ? { private: true } : {}) },
    // Opened by address, outside a list: what is known without the reader's query.
    background: { reasons: withdrawn ? ['withdrawn'] : [], placement: null, blyg: false },
  };
}
/** A standalone import when no loaded Reading row is held. */
function importedEntry(
  item: ImportedItem,
  source: Subscription | undefined,
  rank: number,
): Reading {
  const withdrawn = item.state === 'tombstone';
  const displayAt =
    item.updated && Date.parse(item.updated) < Date.parse(item.observedAt)
      ? item.updated
      : item.observedAt;
  return {
    key: `imported:${JSON.stringify([item.subscriptionId, item.remoteId])}`,
    source: 'imported',
    kind: item.kind,
    withdrawn,
    l0: item.l0,
    contentHtml: item.contentHtml,
    displayAt,
    rank,
    background: { reasons: withdrawn ? ['withdrawn'] : [], placement: null, blyg: source?.background ?? false },
    imported: {
      subscriptionId: item.subscriptionId,
      subscriptionTitle: source ? sourceName(source) : item.subscriptionId,
      remoteId: item.remoteId,
      kind: item.kind,
      withdrawn,
      l0: item.l0,
      updated: item.updated,
      observedAt: item.observedAt,
      contentHtml: item.contentHtml,
      pinnedVersionRetained: item.pinnedVersionRetained,
      sourceUrl: source
        ? sourceTitleAndUrl({ l0: item.l0 ? 1 : 0, kind: item.kind, remote_id: item.remoteId, content_html: item.contentHtml, page: item.page }, source.origin)
            .url
        : null,
      version: item.version,
      // The standalone import resource carries no owner read-state join.
      readVersion: null,
      ...(item.syndication ? { syndication: item.syndication } : {}),
    },
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
      unwrap(BlyggerApi.getImportedItem({ client, path: { sub, id }, signal })).then(item => importedEntry(item, subscriptions.get(sub), 0)),
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
  const markRead = useSettings()?.readerMarkRead ?? 'seen';
  useEffect(() => {
    if (marked.current === entry.key) return;
    marked.current = entry.key;
    if (markRead === 'never' || !needsRead(readStatus(entry.imported))) return;
    // A row reading holds is marked through it (every view updates at once);
    // one fetched by its address has no row to change, so it is written direct.
    const write = reading.toArray.some((row) => row.key === entry.key)
      ? markEntries([entry], true)
      : markUnheldRead(readWrites([entry], true));
    void write.catch(() => toast('Could not store the read mark.'));
  }, [entry.key]);
  const a = useEntryActions({ entry, actions, votes, buckets, opened: () => {} });
  const content = useMemo(() => splitTitle(entry.contentHtml, entry.l0), [entry.contentHtml, entry.l0]);
  return (
    <article className="entry reading-article" data-key={entry.key}>
      <div className="entry-in article-byline">
        <Byline entry={entry} a={a} />
      </div>
      {/* The actions lead a full view (Venkat, session 87): below a long body
          they were a scroll away. The history they open sits with them. */}
      <EntryBar entry={entry} a={a} />
      {a.imported && !entry.l0 && a.historyOpen ? (
        <History sub={a.imported.subscriptionId} id={a.id} />
      ) : null}
      <div className="entry-in article-main">
        <Tomb entry={entry} />
        <ChangeLead entry={entry} opened />
        <EntryTitle title={content.title} url={a.url} as="h2" className="entry-title article-title" />
        <ReaderBody html={content.html} origin={origin} className="content entry-body article-body" />
        <SourceLink url={a.url} />
        <CopiesElsewhere entries={entry.imported?.syndication} />
        <BurstParts entry={entry} open />
      </div>
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
          {shown.lastPollAt
            ? `last polled ${pollTime(shown.lastPollAt, timeZone)}`
            : 'never polled'}
        </dd>
        <dt>failures</dt>
        <dd className={shown.failCount ? 'bad' : undefined}>
          {shown.failCount}
        </dd>
        <dt>items</dt>
        <dd>{count ?? '…'}</dd>
      </dl>
      <label className="check">
        <input
          type="checkbox"
          checked={shown.inBlogroll}
          onChange={(event) => {
            const checked = event.target.checked;
            setError(undefined);
            subscriptions
              .update(shown.id, (row) => {
                row.inBlogroll = checked;
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
      <label className="check">
        <input
          type="checkbox"
          checked={shown.background}
          onChange={(event) => {
            const checked = event.target.checked;
            setError(undefined);
            setBlygBackground({ id: shown.id, background: checked }).then(
              () => toast(checked ? 'moved to Background' : 'back in the main lenses'),
              setError,
            );
          }}
        />
        <span>
          in Background
          <span className="hint">
            Its entries leave the other lenses for Background, except any you
            moved to Foreground. Nothing is marked read.
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
                  const result = await resyncSubscription(shown.id);
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
        onSubscribed={(told) => {
          onClose();
          if (!told) toast('subscribed');
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
  all: 'Feed',
  threads: 'Threads',
  fragments: 'Fragments',
  mentions: 'Mentions',
  agentic: 'Agentic feed',
  shelf: 'Saved',
  background: 'Background',
  raw: 'Raw',
};
const isFeed = (lens: Lens) => (FEED_LENSES as readonly string[]).includes(lens);
/**
 * The tab bar at the top of every reading screen (session 77, Venkat): Feed,
 * Mentions, Agentic feed, Saved, Background, Raw. The Feed is ordered and
 * folded by structure only (pace-layered, Background's rules); the Agentic
 * feed is where an assistant makes editorial judgments; Raw is what came in,
 * unaltered. Threads and Fragments narrow the Feed, from its own controls.
 */
function LensBar({ sub, hopper, sources }: { sub?: string; hopper?: string; sources?: boolean }) {
  const lens = useContext(LensContext);
  const navigate = useNavigate();
  const bar = useRef<HTMLDivElement>(null);
  const tab = isFeed(lens) ? 'all' : lens;
  // The owner names the Agentic feed tab (session 77): "Daily digest", "My briefing".
  const settings = useSettings();
  const agenticTitle = settings?.agenticTitle || LENS_LABELS.agentic;
  // With the feed off, the owner may hide its tab (session 90).
  const tabs = READING_TABS.filter((value) => value !== 'agentic' || !(settings?.agenticDriver === 'off' && settings.agenticHidden));
  // On a phone the bar scrolls sideways; keep the chosen tab in view.
  useEffect(() => {
    const el = bar.current?.querySelector<HTMLElement>('[aria-checked=true]');
    const box = bar.current;
    if (!el || !box) return;
    // Scroll only the bar, never the page.
    if (el.offsetLeft + el.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollLeft = el.offsetLeft + el.offsetWidth - box.clientWidth;
    else if (el.offsetLeft < box.scrollLeft) box.scrollLeft = el.offsetLeft;
  }, [tab]);
  const place = sources
    ? { view: 'sources' as const }
    : hopper
      ? { hopper, offset: 0 }
      : sub && sub !== 'all'
        ? { sub, offset: 0 }
        : {};
  const go = (value: Lens) => void navigate({ to: '/reading', search: { ...place, ...(value === 'all' ? {} : { lens: value }) } });
  // Buttons, not router Links: a Link to /reading counts as "current" under
  // every lens, which would mark Feed active alongside the real choice.
  return (
    <>
      <ToggleGroup ref={bar} className="lens-bar" aria-label="reading tabs" value={[tab]}>
        {tabs.map((value) => (
          <Toggle
            key={value}
            className={value === 'agentic' ? 'seg-dashed' : undefined}
            value={value}
            onClick={() => go(value)}
          >
            {value === 'agentic' ? agenticTitle : LENS_LABELS[value]}
          </Toggle>
        ))}
      </ToggleGroup>
      {isFeed(lens) ? <FeedControls lens={lens} go={go} hopper={hopper} /> : null}
    </>
  );
}
/**
 * The Feed's own controls: which kinds it shows, and its order (pace-layered,
 * the default, or chronological). The order is the readerOrder setting, so it
 * holds across visits and devices; a hopper keeps its own order.
 */
function FeedControls({ lens, go, hopper }: { lens: Lens; go: (lens: Lens) => void; hopper?: string }) {
  const settings = useSettings();
  const order = settings?.readerOrder ?? 'pace-layered';
  const switchOrder = async (next: 'pace-layered' | 'newest') => {
    if (next === order) return;
    await settingsCollection.update('settings', (row) => {
      row.readerOrder = next;
    }).when('settled');
    await queryClient.invalidateQueries({ queryKey: ['reading'] });
  };
  return (
    <div className="feed-controls">
      <ToggleGroup className="feed-kinds" aria-label="feed kinds" value={[lens]}>
        {FEED_LENSES.map((value) => (
          <Toggle key={value} value={value} onClick={() => go(value)}>
            {value === 'all' ? 'All' : LENS_LABELS[value]}
          </Toggle>
        ))}
      </ToggleGroup>
      {hopper ? null : (
        <ToggleGroup className="feed-order" aria-label="feed order" value={[order]}>
          <Toggle value="pace-layered" onClick={() => void switchOrder('pace-layered').catch(() => toast('Could not change the order.'))}>
            Pace-layered
          </Toggle>
          <Toggle value="newest" onClick={() => void switchOrder('newest').catch(() => toast('Could not change the order.'))}>
            Chronological
          </Toggle>
        </ToggleGroup>
      )}
    </div>
  );
}
const SHELF_NOTE = 'What you saved, yours and the blygs you read, in your order. Your drafts in it are under compose.';
const MENTIONS_NOTE = 'Items you already read that name you. A find, not a notification: nobody told you, and nothing here is verified.';
const RAW_NOTE = 'What came in from the blygs you read, newest first, as it arrived: nothing moved to Background, nothing folded.';
/** What the Feed leaves out: withdrawn posts, small and maintenance changes, folded parts, and what you moved. */
export const BACKGROUND_NOTE = 'What the Feed leaves out: withdrawn posts, republished or barely changed versions, parts folded under their thread, and what you moved here. Settings → Background says which rules act.';
export const AGENTIC_FEED_NOTE = 'Coming soon. An assistant who organizes your reading for you. You can already set its prompt in Settings.';
const isPlaceholder = (lens: Lens): lens is 'agentic' => lens === 'agentic';
function LensPlaceholder() {
  return (
    <div className="empty lens-placeholder">
      <span className="em" aria-hidden="true">
        ✦
      </span>
      <strong>Coming soon.</strong> An assistant who organizes your reading for
      you: what you should see, and how. You can already set its prompt in{' '}
      <Link to="/settings" hash="ai-feed">Settings</Link>.
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
  const collection = useMemo(() => hopperInfo(id), [id]);
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
                {row.sourceCount} source{row.sourceCount === 1 ? '' : 's'} ·{' '}
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
  sub: 'all' | 'own' | 'private';
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
  // Notebook mode lists the private source, as it adds private above compose.
  const notebook = useSettings()?.defaultVisibility === 'private';
  const actions = useReadingActions();
  const { toggle } = useSubscriptionActions(actions);
  const [inspect, setInspect] = useState<string>();
  const [importing, setImporting] = useState(false);
  // The summary carries counts for every source under the selected lens.
  const lens = useContext(LensContext);
  const allKey = readingKey('all', lens);
  const summary = useLiveQuery(readingSummaryView(allKey));
  const sources =
    useLiveQuery({ query: (q) => q.from({ source: subscriptions }) }).data ??
    [];
  const buckets =
    useLiveQuery({ query: (q) => q.from({ hopper: hoppers }) }).data ?? [];
  const counts = summary.data?.[0]?.counts;
  // No tally of who named you (tn-6 section 6, rule 3).
  const shown = (count: number | undefined) => (lens === 'mentions' ? undefined : count);
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
        <SmartSource sub="all" icon="◫" title="all" count={shown(counts?.all)} />
        <SmartSource sub="own" icon="❝" title="my blyg" count={shown(counts?.own)} />
        {notebook ? <SmartSource sub="private" icon="◇" title="private" count={shown(counts?.private)} /> : null}
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
          {sources.filter((source) => source.inBlogroll).length} in blogroll
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
                count={shown(counts?.subscriptions[source.id])}
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
        count={inspected ? shown(counts?.subscriptions[inspected.id]) : undefined}
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
    <Tabs className="reading-tabs" label="reading view" value={active} onValueChange={(value) => {
      const next = value as 'feed' | 'sources';
      void navigate({
        to: '/reading',
        search: { ...(next === 'sources' ? { view: 'sources' as const } : {}), ...lensSearch },
      });
    }}>
      {(['feed', 'sources'] as const).map((value) => (
        <Tab
          key={value}
          value={value}
        >
          {value === 'feed' ? 'Feed' : 'Sources'}
        </Tab>
      ))}
    </Tabs>
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
  const [discovering, setDiscovering] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  // Native collection polling observes the server's background work.
  const resyncAll = async () => {
    setResyncing(true);
    try {
      const { polling } = await pollSubscriptions();
      toast(`Checking ${polling} feed${polling === 1 ? '' : 's'}…`);
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
          <IconButton className="icon-btn" label="resync all feeds" disabled={resyncing} onClick={() => void resyncAll()}>
            ↻
          </IconButton>
          <IconButton className="icon-btn" id="discover-open" label="discover blygs on blygger.com" onClick={() => setDiscovering(true)}>
            ✦
          </IconButton>
          <IconButton className="icon-btn" label="subscribe" onClick={() => setAdding(true)}>
            ＋
          </IconButton>
        </div>
      </div>
      <SubscribeSheet open={adding} onClose={() => setAdding(false)} onImport={() => setImporting(true)} />
      <OpmlImportSheet open={importing} onClose={() => setImporting(false)} />
      <DiscoverSheet open={discovering} onClose={() => setDiscovering(false)} />
    </>
  );
}
/** How long an entry stays on screen before scanning it counts as reading it. */
const SEEN_MS = 1000;
/** Seen marks wait this long to go out together: one request for a screenful. */
const SEEN_FLUSH_MS = 3000;
/**
 * "Seen means read" (session 79): an imported entry counts as read once its
 * card, or as much of it as fits the screen, has been visible for SEEN_MS.
 * Short entries are covered, which opening never could. Each card registers
 * itself through `watch` as it mounts, so a remounted list is still seen.
 * Marks are batched and flushed every SEEN_FLUSH_MS and when the page hides.
 */
function useSeenMarks(entries: Reading[], enabled: boolean): ((card: HTMLElement) => () => void) | undefined {
  const byKey = useRef(new Map<string, Reading>());
  byKey.current = new Map(entries.map((entry) => [entry.key, entry]));
  const [tracker, setTracker] = useState<{ observer: IntersectionObserver } | null>(null);
  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === 'undefined') return;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const pending = new Map<string, Reading>();
    const done = new Set<string>();
    const flush = () => {
      if (!pending.size) return;
      const batch = [...pending.values()].filter((entry) => needsRead(readStatus(entry.imported)));
      pending.clear();
      if (batch.length) void markEntries(batch, true).catch(() => undefined);
    };
    const interval = setInterval(flush, SEEN_FLUSH_MS);
    const hidden = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', flush);
    const observer = new IntersectionObserver((seen) => {
      for (const sight of seen) {
        const key = (sight.target as HTMLElement).dataset.key ?? '';
        const box = sight.boundingClientRect;
        // The whole card, or a tall card filling most of the screen.
        const visible = sight.isIntersecting && (sight.intersectionRatio >= 0.99 || sight.intersectionRect.height >= Math.min(box.height, window.innerHeight) * 0.6);
        if (visible && !timers.has(key) && !done.has(key)) {
          timers.set(key, setTimeout(() => {
            timers.delete(key);
            done.add(key);
            const entry = byKey.current.get(key);
            if (entry?.imported && needsRead(readStatus(entry.imported))) pending.set(key, entry);
          }, SEEN_MS));
        } else if (!visible && timers.has(key)) {
          clearTimeout(timers.get(key));
          timers.delete(key);
        }
      }
    }, { threshold: [0, 0.25, 0.5, 0.6, 0.75, 0.99, 1] });
    setTracker({ observer });
    return () => {
      setTracker(null);
      observer.disconnect();
      for (const timer of timers.values()) clearTimeout(timer);
      clearInterval(interval);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [enabled]);
  return useMemo(() => tracker ? (card: HTMLElement) => {
    tracker.observer.observe(card);
    return () => tracker.observer.unobserve(card);
  } : undefined, [tracker]);
}
/**
 * Read state on a timeline: unread dots, mark-read-on-open, select mode with
 * mark read / mark unread for the ticked rows, and "mark all read" for the
 * whole view — every page of this source under this lens, not only the page
 * on screen, sent in batches of at most 500.
 */
function useReadSelection(key: string, offset: number, entries: Reading[], actions: Actions, title: string, lens: Lens) {
  const markRead = useSettings()?.readerMarkRead ?? 'seen';
  const watch = useSeenMarks(entries, markRead === 'seen');
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
        if (markRead !== 'never' && needsRead(readStatus(entry.imported))) void actions.run(() => markEntries([entry], true));
      },
      watch,
    }),
    [selecting, picked, key, actions, markRead, watch],
  );
  const importedRows = entries.filter((entry) => entry.imported);
  const apply = (read: boolean) => {
    const chosen = importedRows.filter((entry) => picked.has(entry.key));
    stop();
    if (chosen.length) void actions.run(() => markEntries(chosen, read));
  };
  const markAll = () =>
    actions.run(async () => {
      const rows: Markable[] = await readAllReading(key);
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
    <Tooltip label="select, mark read or unread">
      <Button className="icon-btn" aria-label="read state" aria-pressed={selecting} onClick={openMenu}>
        ☑
      </Button>
    </Tooltip>
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
function Timeline({ sub, offset, from }: { sub: string; offset: number; from?: 'feed' }) {
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
  const metadata = useLiveQuery(readingSummaryView(key)).data?.[0];
  const selected = sources.find((source) => source.id === sub);
  const title =
    sub === 'all'
      ? 'all'
      : sub === 'own'
        ? 'my blyg'
        : sub === 'private'
          ? 'private'
          : selected
          ? sourceName(selected)
          : 'all';
  // Your own items have no read state, private ones included.
  const readable = sub !== 'own' && sub !== 'private' && !isPlaceholder(lens);
  useReturnPoint(!!entries.data?.length);
  const read = useReadSelection(key, offset, entries.data ?? [], actions, title, lens);
  // One source's view leads back where it was opened from: the main feed when
  // reached from an entry's source name (from=feed), else the Sources tab.
  const single = sub === 'own' || sub === 'private' || !!selected;
  return (
    <ReadContext.Provider value={read.ui}>
      {single ? (
        from === 'feed' ? (
          <Link className="back-link" to="/reading" search={lensSearch}>
            ← main feed
          </Link>
        ) : (
          <Link className="back-link" to="/reading" search={{ view: 'sources', ...lensSearch }}>
            ← sources
          </Link>
        )
      ) : null}
      <ReadingHead title={title} count={lens === 'mentions' ? undefined : metadata?.total}>
        {readable ? read.button : null}
        {selected ? (
          <IconButton className="icon-btn" label="about this source" onClick={() => setInspecting(true)}>
            ⓘ
          </IconButton>
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
        <AgenticFeed />
      ) : (
        <>
          {lens === 'background' ? <p className="view-sub">{BACKGROUND_NOTE}</p> : null}
          {lens === 'mentions' ? <p className="view-sub">{MENTIONS_NOTE}</p> : null}
          {lens === 'shelf' ? <p className="view-sub">{SHELF_NOTE}</p> : lens === 'raw' ? <p className="view-sub">{RAW_NOTE}</p> : null}
          {entries.isLoading ? <p className="view-sub">Loading reading…</p> : null}
          <EntryList entries={entries.data ?? []} actions={actions} />
          {!entries.isLoading && !entries.data?.length ? (
            <div className="empty">
              <span className="em" aria-hidden="true">
                ◫
              </span>
              {lens === 'background' ? 'Nothing withdrawn.' : lens === 'mentions' ? 'Nothing you read mentions you yet.' : lens === 'shelf' ? 'Nothing saved yet: “save” on any entry puts it here.' : 'No items yet.'}
            </div>
          ) : null}
          <Pager
            offset={offset}
            total={metadata?.total}
            go={(next) =>
              void actions.navigate({
                to: '/reading',
                search: { sub, offset: next, ...lensSearch, ...(from ? { from } : {}) },
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
  const collection = useMemo(() => hopperInfo(id), [id]);
  const result = useLiveQuery({ query: q => q.from({ hopper: collection }) });
  const row = result.data?.[0];
  const lens = useContext(LensContext);
  const key = readingKey('hopper:' + id, lens);
  const entries = useLiveQuery(readingView(key, offset)).data ?? [];
  const metadata = useLiveQuery(readingSummaryView(key)).data?.[0];
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
  const start = offset;
  return (
    <>
      <ReadingHead title={row.hopper.name} count={metadata?.total}>
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
          entries={entries}
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
          total={metadata?.total}
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

/**
 * Search on the reading page (docs/search.md): the picker's scope, narrowed to
 * the selected source when there is one, with a chip to widen it. A hopper, a
 * lens or Background does not narrow it; the route has no such filter.
 */
function ReadingSearch({ q, sub }: { q: string; sub?: string }) {
  const navigate = useNavigate();
  const [wide, setWide] = useState(false);
  useEffect(() => setWide(false), [sub]);
  const one = sub && sub !== 'all' ? sub : undefined;
  const narrowed = one && !wide ? one : undefined;
  const title = narrowed === '~own' ? 'my blyg' : narrowed ? subscriptions.get(narrowed)?.title || narrowed : '';
  const filters: SearchFilters = narrowed === '~own' ? { q, source: 'mine' } : narrowed ? { q, source: 'imported', sub: narrowed } : { q };
  return (
    <>
      {narrowed ? (
        <p className="search-scope">
          searching <strong>{title}</strong> only ·{' '}
          <button type="button" className="btn btn-ghost btn-mini" onClick={() => setWide(true)}>search everything</button>
        </p>
      ) : one && wide ? (
        <p className="search-scope">
          searching everything ·{' '}
          <button type="button" className="btn btn-ghost btn-mini" onClick={() => setWide(false)}>only this source</button>
        </p>
      ) : null}
      <SearchResults filters={filters} ownOpens="reader" />
      <p className="search-scope">
        <button type="button" className="btn btn-ghost btn-mini" onClick={() => void navigate({ to: '/reading', search: (prev) => ({ ...prev, q: undefined }) })}>
          back to the feed
        </button>
      </p>
    </>
  );
}

export function ReadingPage({
  sub,
  hopper,
  offset,
  lens = 'all',
  view,
  q,
  from,
}: {
  sub?: string;
  hopper?: string;
  offset?: number;
  lens?: Lens;
  view?: 'sources';
  q?: string;
  from?: 'feed';
}) {
  // A timeline or source list is where a walk through the thicket ends.
  useEndTrail();
  const navigate = useNavigate();
  const setQuery = (next: string) =>
    void navigate({ to: '/reading', search: (prev) => ({ ...prev, q: next || undefined }), replace: true });
  return (
    <LensContext.Provider value={lens}>
      <div className="page-search-row">
        <SearchBox value={q ?? ''} onChange={setQuery} label="search reading" />
      </div>
      {q ? (
        <ReadingSearch q={q} sub={hopper ? undefined : sub} />
      ) : view === 'sources' ? (
        <Sources />
      ) : hopper ? (
        <HopperTimeline id={hopper} offset={offset ?? 0} />
      ) : (
        <Timeline sub={sub ?? 'all'} offset={offset ?? 0} from={from} />
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
      setDiff({ from, to, ops: diffText(a.contentMd, b.contentMd) });
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
