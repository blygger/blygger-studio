import type { ReactNode } from 'react';
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
} from 'react';
import { Button } from '@base-ui/react/button';
import { Link, useLocation } from '@tanstack/react-router';
import { useLiveQuery } from '@tanstack/react-db';
import {
  settings as settingsCollection,
  items as itemsCollection,
  polling,
  queryClient,
  updates,
} from './data.ts';
import { readState } from '../versions.ts';
import { displayUrl } from '../importer/util.ts';
import { Sheet } from './sheets.tsx';
import { applyTheme } from './theme.ts';
import type { CustomTheme } from '../themes.ts';
export { Button };
export const mount =
  document.getElementById('studio-root')!.dataset.mount ?? '';
export const basepath = `${mount}/studio`;
/** An item's public permalink, mount-relative (the page a reader sees). */
export const publicPath = (item: { id: string; kind: string }) =>
  `${mount}/${item.kind === 'thread' ? 't' : 'f'}/${item.id}/`;
export function usePoll(key: string, refresh: () => Promise<unknown>) {
  useEffect(() => polling.watch(key, refresh), [key, refresh]);
}
export function useSettings() {
  usePoll('settings', settingsCollection.utils.refetch);
  return useLiveQuery({
    query: (q) => q.from({ settings: settingsCollection }),
  }).data?.[0];
}
/** The release check: `behind` when a newer release than this build exists. */
export function useUpdateState() {
  usePoll('updates', updates.utils.refetch);
  const row = useLiveQuery({ query: (q) => q.from({ update: updates }) })
    .data?.[0];
  return row
    ? readState({
        update_latest_seen: row.update_latest_seen || '',
        update_checked_at: row.update_checked_at || '',
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
  if (p === '/reading' || p === '/subs' || p === '/fork') return 'reading';
  if (p === '/hoppers' || p.startsWith('/hoppers/')) return 'hoppers';
  if (p === '/mentions') return 'mentions';
  if (p === '/updates') return 'updates';
  if (p === '/more' || p === '/settings' || p === '/syntax' || p === '/signals' || p === '/access') return 'more';
  return null;
}
function relativePath(pathname: string) {
  return pathname.startsWith(basepath)
    ? pathname.slice(basepath.length) || '/'
    : pathname;
}

export function Layout({ children }: { children: ReactNode }) {
  const settings = useSettings();
  const update = useUpdateState();
  const path = relativePath(useLocation({ select: (l) => l.pathname }));
  const active = tabFor(path);
  const [chrome, setChrome] = useState<ChromeOptions>({});
  const showTabs = chrome.tabs ?? true;
  const framed = chrome.framed ?? true;
  const wide = chrome.wide ?? (path === '/reading' || path.startsWith('/edit/'));
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    const failure = (event: Event) => setError((event as CustomEvent).detail);
    window.addEventListener('studio-read-error', failure);
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      // Source collections report shared-read failures after handling expected 404s.
      if (event.type === 'updated' && event.query.queryKey[0] !== 'owner-read' &&
          event.query.state.status === 'error')
        setError(event.query.state.error);
    });
    return () => {
      window.removeEventListener('studio-read-error', failure);
      unsubscribe();
    };
  }, []);
  // The studio wears the reading theme. Until settings load, the theme
  // applied at startup (the last one seen on this device) stays.
  const theme = settings?.theme;
  // The palettes as strings, so the effect re-runs on a changed colour but not
  // on every new settings object with the same values.
  const customKey = settings?.custom_theme
    ? JSON.stringify(settings.custom_theme)
    : '';
  const customDarkKey = settings?.custom_theme_dark
    ? JSON.stringify(settings.custom_theme_dark)
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
  const allItems =
    useLiveQuery({ query: (q) => q.from({ item: itemsCollection }) }).data;
  const editedItem = editing
    ? allItems?.find((item) => item.id === editing)
    : undefined;
  const publicHref =
    editedItem?.status === 'public' ? publicPath(editedItem) : `${mount}/`;
  const behind = !!(settings?.update_check && update?.behind);
  const unacked = !!(settings?.update_check && !settings.update_notice_ack);
  return (
    <ChromeContext.Provider value={setChrome}>
      <header className="topbar">
        <h1 className="topbar-title">
          <span aria-hidden="true">❝ </span>
          {settings?.site_title ? `${settings.site_title} ` : ''}
          <small>blygger studio</small>
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
                setError(undefined);
                void polling.refresh();
              }}
            >
              retry reads
            </Button>
          </div>
        ) : null}
        <div className={framed ? 'screen framed' : 'screen'}>{children}</div>
      </main>
      {showTabs ? (
        <nav className="tabbar" aria-label="studio">
          {tabs.map((tab) => (
            <Link
              key={tab.label}
              to={tab.to}
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
