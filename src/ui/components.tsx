import type { ReactNode } from 'react';
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import { Button } from '@base-ui/react/button';
import { Link, useLocation } from '@tanstack/react-router';
import { eq, useLiveQuery, type Collection } from '@tanstack/react-db';
import { CancelledError, type QueryClient } from '@tanstack/query-core';
import {
  settings as settingsCollection,
  items as itemsCollection,
  queryClient,
  updates,
} from './data.ts';
import * as sourceData from './data.ts';
import { readState } from '../versions.ts';
import { displayUrl } from '../importer/util.ts';
import { Sheet } from './sheets.tsx';
import { SetupBanner } from './setup.tsx';
import { applyTheme } from './theme.ts';
import type { CustomTheme } from '../themes.ts';
export { Button };
export const mount =
  document.getElementById('studio-root')!.dataset.mount ?? '';
export const basepath = `${mount}/studio`;
/** An item's public permalink, mount-relative (the page a reader sees). */
export const publicPath = (item: { id: string; kind: string }) =>
  `${mount}/${item.kind === 'thread' ? 't' : 'f'}/${item.id}/`;
export function useSettings() {
  return useLiveQuery({
    query: (q) => q.from({ settings: settingsCollection }),
  }).data?.[0];
}
/** The release check: `behind` when a newer release than this build exists. */
export function useUpdateState() {
  const row = useLiveQuery({ query: (q) => q.from({ update: updates }) })
    .data?.[0];
  return row
    ? readState({
        update_latest_seen: row.updateLatestSeen || '',
        update_checked_at: row.updateCheckedAt || '',
      })
    : undefined;
}
/** Every reading card's citation line: where the entry lives, in a new tab. */
export function SourceLink({ url }: { url?: string | null }) {
  return url ? (
    <a className="entry-src" href={url} target="_blank" rel="noreferrer">
      <span aria-hidden="true">↗ </span>
      {displayUrl(url)}
    </a>
  ) : null;
}
export function Html({ html, id }: { html: string; id?: string }) {
  return <div id={id} dangerouslySetInnerHTML={{ __html: html }} />;
}
export function Failure({ error }: { error: unknown }) {
  return error ? (
    <p className="error-banner" role="alert">
      {error instanceof Error ? error.message : String(error)}
    </p>
  ) : null;
}
/** A titled sheet with arbitrary content. Kept for existing callers; new code
 *  can use <Sheet> from sheets.tsx directly. */
export function Modal({
  open,
  close,
  title,
  children,
  closeButton = true,
}: {
  open: boolean;
  close: () => void;
  title: string;
  children: ReactNode;
  /** Off when the dialog's own actions already include a way out. */
  closeButton?: boolean;
}) {
  return (
    <Sheet open={open} onClose={close} title={title} className="dialog-popup">
      {children}
      {closeButton ? <Sheet.Close>close</Sheet.Close> : null}
    </Sheet>
  );
}


/* ---------------- CHROME ----------------
 * A screen tells the Layout how to frame it with useChrome():
 *   tabs   — show the bottom tab bar / left rail (default true). The editor
 *            turns it off and renders its own <ActionBar>.
 *   framed — sit the screen on one card (default true). Screens not yet
 *            redesigned need it so their text reads against the card (Slate's
 *            page is dark); redesigned screens turn it off and lay out cards.
 *   wide   — the 1240px measure instead of 760px (default: reading, editor).
 */
export interface ChromeOptions {
  tabs?: boolean;
  framed?: boolean;
  wide?: boolean;
}
const ChromeContext = createContext<(options: ChromeOptions) => void>(
  () => {},
);
export function useChrome(options: ChromeOptions) {
  const set = useContext(ChromeContext);
  const { tabs, framed, wide } = options;
  useLayoutEffect(() => {
    set({ tabs, framed, wide });
    return () => set({});
  }, [set, tabs, framed, wide]);
}
/** A bottom action bar, for screens that hide the tab bar (the editor). */
export function ActionBar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className ? `actionbar ${className}` : 'actionbar'}>
      {children}
    </div>
  );
}

const tabs = [
  { label: 'reading', to: '/reading', icon: '◫' },
  { label: 'compose', to: '/', icon: '✎' },
  { label: 'hoppers', to: '/hoppers', icon: '▤' },
  { label: 'mentions', to: '/mentions', icon: '↩' },
  { label: 'updates', to: '/updates', icon: '↻' },
  { label: 'more', to: '/more', icon: '⋯' },

] as const;
type Tab = (typeof tabs)[number]['label'];
/** Which tab owns a studio path (relative to the basepath). */
export function tabFor(path: string): Tab | null {
  const p = path.replace(/\/+$/, '') || '/';
  if (p === '/' || p.startsWith('/edit/')) return 'compose';
  if (p === '/reading' || p.startsWith('/reading/') || p === '/subs' || p === '/fork') return 'reading';
  if (p === '/hoppers' || p.startsWith('/hoppers/')) return 'hoppers';
  if (p === '/mentions') return 'mentions';
  if (p === '/updates') return 'updates';
  if (p === '/more' || p === '/settings' || p === '/syntax' || p === '/signals' || p === '/access' || p === '/components') return 'more';
  return null;
}
function relativePath(pathname: string) {
  return pathname.startsWith(basepath)
    ? pathname.slice(basepath.length) || '/'
    : pathname;
}

type ReadSource = Pick<Collection, 'health' | 'subscriberCount' | 'on' | 'reload'>;
function isReadSource(value: unknown): value is ReadSource {
  return typeof value === 'object' && value !== null &&
    'health' in value && 'subscriberCount' in value && 'on' in value && 'reload' in value;
}
const readSources = Object.values<unknown>(sourceData).filter(isReadSource);

/** Read the current problem, including failures before the first rows arrive. */
export function currentReadProblem(sources: readonly ReadSource[]) {
  for (const source of sources) {
    if (!source.subscriberCount) continue;
    const problem = source.health.error ?? source.health.failureReason;
    if (problem && !(problem.cause instanceof CancelledError)) return problem;
  }
  return undefined;
}
export function subscribeReadHealth(sources: readonly ReadSource[], notify: () => void) {
  const unsubscribers = sources.flatMap(source => [
    source.on('health:change', notify),
    source.on('subscribers:change', notify),
  ]);
  return () => { for (const unsubscribe of unsubscribers) unsubscribe(); };
}
/** First-load and failed window requests need a new sync run; transient sync failures can refetch. */
export async function retryReadProblems(sources: readonly ReadSource[], client: QueryClient = queryClient) {
  await Promise.allSettled(sources
    .filter(source => source.subscriberCount && source.health.error)
    .map(source => source.reload()));
  await client.refetchQueries({ type: 'active' });
}
const subscribeReadProblems = (notify: () => void) => subscribeReadHealth(readSources, notify);
const readProblemSnapshot = () => currentReadProblem(readSources);

export function Layout({ children }: { children: ReactNode }) {
  const settings = useSettings();
  const update = useUpdateState();
  const path = relativePath(useLocation({ select: (l) => l.pathname }));
  const active = tabFor(path);
  const [chrome, setChrome] = useState<ChromeOptions>({});
  const showTabs = chrome.tabs ?? true;
  const framed = chrome.framed ?? true;
  const wide = chrome.wide ?? (path === '/reading' || path.startsWith('/edit/'));
  const readProblem = useSyncExternalStore(subscribeReadProblems, readProblemSnapshot);
  const error = readProblem?.cause ?? readProblem?.message;
  // The studio wears the reading theme. Until settings load, the theme
  // applied at startup (the last one seen on this device) stays.
  const theme = settings?.theme;
  // The palettes as strings, so the effect re-runs on a changed colour but not
  // on every new settings object with the same values.
  const customKey = settings?.customTheme
    ? JSON.stringify(settings.customTheme)
    : '';
  const customDarkKey = settings?.customThemeDark
    ? JSON.stringify(settings.customThemeDark)
    : '';
  useEffect(() => {
    if (theme === undefined) return;
    const custom = customKey ? (JSON.parse(customKey) as CustomTheme) : null;
    const customDark = customDarkKey
      ? (JSON.parse(customDarkKey) as CustomTheme)
      : null;
    applyTheme(theme, custom, customDark);
    // `auto` and a custom light/dark pair follow the device; keep in step when it flips.
    const media = matchMedia('(prefers-color-scheme: dark)');
    const flip = () => applyTheme(theme, custom, customDark);
    media.addEventListener('change', flip);
    return () => media.removeEventListener('change', flip);
  }, [theme, customKey, customDarkKey]);
  useEffect(() => {
    document.body.classList.toggle('has-tabs', showTabs);
    document.body.classList.toggle('no-tabs', !showTabs);
  }, [showTabs]);
  // In the editor of a published item, "public page" means that item's page;
  // everywhere else it is the blyg's home.
  const editing = path.startsWith('/edit/') ? path.split('/')[2] : undefined;
  const editedItem = useLiveQuery({
    query: (q) => editing
      ? q.from({ item: itemsCollection }).where(({ item }) => eq(item.id, editing)).findOne()
      : undefined,
  }).data;
  const publicHref =
    editedItem?.status === 'public' ? publicPath(editedItem) : `${mount}/`;
  const behind = !!(settings?.updateCheck && update?.behind);
  const unacked = !!(settings?.updateCheck && !settings.updateNoticeAck);
  return (
    <ChromeContext.Provider value={setChrome}>
      <header className="topbar">
        <h1 className="topbar-title">
          <Link to="/reading">
            <span aria-hidden="true">❝ </span>
            {settings?.siteTitle ? `${settings.siteTitle} ` : ''}
            <small>blygger studio</small>
          </Link>
        </h1>
        <div className="topbar-actions">
          {behind ? (
            <Link
              to="/more"
              className="tb-badge warn"
              id="update-badge"
              title="A newer release exists"
            >
              update
            </Link>
          ) : null}
          <a
            className="tb-btn"
            href={publicHref}
            target="_blank"
            rel="noreferrer"
            aria-label="public page ↗"
          >
            <span className="lbl">public page </span>↗
          </a>
        </div>
      </header>
      <main className={wide ? 'views wide' : 'views'}>
        {error ? (
          <div className="read-error">
            <Failure error={error} />
            <Button
              className="btn btn-ghost btn-mini"
              onClick={() => {
                void retryReadProblems(readSources);
              }}
            >
              retry reads
            </Button>
          </div>
        ) : null}
        {path === '/setup' ? null : <SetupBanner />}
        <div className={framed ? 'screen framed' : 'screen'}>{children}</div>
      </main>
      {showTabs ? (
        <nav className="tabbar" aria-label="studio">
          {tabs.map((tab) => (
            <Link
              key={tab.label}
              to={tab.to}
              preload={tab.label === 'mentions' ? 'viewport' : undefined}
              className={tab.label === active ? 'tab is-active' : 'tab'}
              aria-current={tab.label === active ? 'page' : undefined}
            >
              <span className="ti" aria-hidden="true">
                {tab.icon}
              </span>
              <span className="tl">{tab.label}</span>
              {tab.label === 'more' && (behind || unacked) ? (
                <span className="flag" aria-hidden="true" />
              ) : null}
            </Link>
          ))}
        </nav>
      ) : null}
    </ChromeContext.Provider>
  );
}
