// The design system first, so each screen's own stylesheet (imported by its
// module below) comes after it in the bundle and wins ties.
import './studio.css';
import { createRoot } from 'react-dom/client';
import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { Layout, basepath } from './components.tsx';
import { Compose, EditorPage } from './authoring.tsx';
import { ReadingArticle, ReadingPage } from './reading.tsx';
import { AuthorizationsPage } from './authorizations.tsx';
import { SettingsPage } from './settings.tsx';
import {
  HoppersPage,
  HopperPage,
  MentionsPage,
  ForkPage,
  loadForkOptions,
} from './catalog.tsx';
import {
  itemDetail,
  hopperDetail,
  readingView,
  readingKey,
  LENSES,
  type Lens,
  queryClient,
  listViews,
  preloadView,
  preloadDetail,
} from './data.ts';
import { Button } from './components.tsx';
import type { CachedResponse } from './revision-query.ts';
import { SyntaxPage } from './syntax.tsx';
import { MorePage } from './more.tsx';
import { UpdatesPage } from './updates.tsx';
import { SignalsPage } from './signals.tsx';
import { SheetHost } from './sheets.tsx';
import { ExtensionPage } from './extension-page.tsx';
import { SetupPage } from './setup.tsx';
import { ComponentLibraryPage } from './component-library.tsx';
import { applyCachedTheme } from './theme.ts';
// Paint the last theme this device saw before the first render; settings
// repaint it once they load (see theme.ts).
applyCachedTheme();
const rootRoute = createRootRoute({
  loader: () => preloadView(listViews.settings),
  pendingComponent: () => <p>Loading Studio…</p>,
  errorComponent: ({ error }) => (
    <div role="alert">
      <p>{error instanceof Error ? error.message : String(error)}</p>
      <Button
        onClick={() =>
          void queryClient
            .resetQueries({
              predicate: (query) => query.state.status === 'error',
            })
            .then(() => router.invalidate())
        }
      >
        retry
      </Button>
    </div>
  ),
  component: () => (
    <Layout>
      <Outlet />
    </Layout>
  ),
  notFoundComponent: () => <p>Studio page not found.</p>,
});
const compose = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  loader: () => preloadView(listViews.items),
  component: Compose,
});
function readingOffset(search: Record<string, unknown>) {
  if (
    typeof search.offset === 'number' &&
    Number.isSafeInteger(search.offset) &&
    search.offset >= 0
  ) {
    return Math.floor(search.offset / 25) * 25;
  }
  if (
    typeof search.page === 'number' &&
    Number.isSafeInteger(search.page) &&
    search.page > 0
  ) {
    return (search.page - 1) * 25;
  }
  return 0;
}
/**
 * /reading is the feed (every source); ?view=sources is the sources list,
 * ?sub=X one source's timeline and ?hopper=H a hopper's. A bookmark that pages
 * without naming a source (?page=2, ?offset=25) still means "all".
 */
function readingSearch(search: Record<string, unknown>): {
  sub?: string;
  hopper?: string;
  offset?: number;
  lens?: Lens;
  view?: 'sources';
} {
  const offset = readingOffset(search);
  const lens =
    typeof search.lens === 'string' && (LENSES as readonly string[]).includes(search.lens) && search.lens !== 'all'
      ? (search.lens as Lens)
      : undefined;
  const withLens = lens ? { lens } : {};
  if (search.view === 'sources') return { view: 'sources', ...withLens };
  if (typeof search.hopper === 'string' && search.hopper)
    return { hopper: search.hopper, offset, ...withLens };
  if (typeof search.sub === 'string') return { sub: search.sub, offset, ...withLens };
  if ('page' in search || 'offset' in search) return { sub: 'all', offset, ...withLens };
  return withLens;
}
const reading = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reading',
  validateSearch: readingSearch,
  loaderDeps: ({ search }) => ({
    sub: search.sub,
    hopper: search.hopper,
    offset: search.offset ?? 0,
    lens: search.lens,
    view: search.view,
  }),
  loader: async ({ deps }) => {
    if (deps.hopper) {
      await Promise.all([
        preloadDetail(hopperDetail(deps.hopper), 'Hopper'),
        preloadView(listViews.subscriptions),
        preloadView(listViews.hoppers),
        preloadView(listViews.signals),
      ]);
      return;
    }
    // The feed and the sources list (whose counts come from the first page
    // of "all") both read "all". The placeholder lenses read the unfiltered
    // key too, for the count in their header.
    const sub = deps.sub ?? 'all';
    const offset = deps.view === 'sources' ? 0 : deps.offset;
    const key = readingKey(sub, deps.lens);
    const view = readingView(key, offset);
    await Promise.all([
      preloadView(view),
      preloadView(listViews.subscriptions),
      preloadView(listViews.hoppers),
      preloadView(listViews.signals),
    ]);
    if (deps.sub === undefined || deps.lens === 'background' || deps.lens === 'smart') return;
    const page = queryClient
      .getQueriesData<
        CachedResponse<import('../../sdk/dist/browser.js').ListReadingResponses[200]>
      >({ queryKey: ['reading', key] })
      .map(([, data]) => data?.data)
      .find((data) => data?.offset === offset);
    if (
      page &&
      (page.selected !== sub || (offset > 0 && offset >= page.total))
    )
      throw redirect({
        to: '/reading',
        search: {
          sub: page.selected,
          offset: offset >= page.total ? 0 : offset,
          ...(deps.lens ? { lens: deps.lens } : {}),
        },
      });
  },
  component: () => <ReadingPage {...reading.useSearch()} />,
});
/**
 * One entry full screen: /reading/{sub}/{id}, `~own` as the sub for your own
 * items. "more" on a card opens it; reloading stays on it.
 */
const article = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reading/$sub/$id',
  loader: () =>
    Promise.all([
      preloadView(listViews.subscriptions),
      preloadView(listViews.hoppers),
      preloadView(listViews.signals),
    ]),
  component: () => {
    const { sub, id } = article.useParams();
    return <ReadingArticle key={`${sub}/${id}`} sub={sub} id={id} />;
  },
});
const edit = createRoute({
  getParentRoute: () => rootRoute,
  path: '/edit/$id',
  loader: ({ params }) => preloadDetail(itemDetail(params.id), 'Item'),
  component: () => {
    const { id } = edit.useParams();
    return <EditorPage id={id} />;
  },
});
const settings = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
});
const setup = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup',
  component: SetupPage,
});
// Feeds are managed from reading now (each source's inspector sheet).
const subs = createRoute({
  getParentRoute: () => rootRoute,
  path: '/subs',
  beforeLoad: () => {
    throw redirect({ to: '/reading', search: { view: 'sources' }, replace: true });
  },
});
const hoppers = createRoute({
  getParentRoute: () => rootRoute,
  path: '/hoppers',
  loader: () => preloadView(listViews.hoppers),
  component: HoppersPage,
});
const hopper = createRoute({
  getParentRoute: () => rootRoute,
  path: '/hoppers/$id',
  loader: ({ params }) =>
    Promise.all([preloadDetail(hopperDetail(params.id), 'Hopper'), preloadView(listViews.subscriptions)]),
  component: () => {
    const { id } = hopper.useParams();
    return <HopperPage id={id} />;
  },
});
const mentions = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mentions',
  loader: () =>
    Promise.all([
      preloadView(listViews.inbound),
      preloadView(listViews.outbound),
      preloadView(listViews.items),
    ]),
  component: MentionsPage,
});
// Quotes that have fallen behind their sources, stalest first (0.23.0).
const updates = createRoute({
  getParentRoute: () => rootRoute,
  path: '/updates',
  loader: () => preloadView(listViews.items),
  component: UpdatesPage,
});
// Thumbs and the private interaction log (0.25.0).
const signalsPage = createRoute({
  getParentRoute: () => rootRoute,
  path: '/signals',
  component: SignalsPage,
});
const fork = createRoute({
  getParentRoute: () => rootRoute,
  path: '/fork',
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    id: string;
    sub?: string;
    origin?: string;
  } => ({
    id: typeof search.id === 'string' ? search.id : '',
    sub: typeof search.sub === 'string' ? search.sub : undefined,
    origin: typeof search.origin === 'string' ? search.origin : undefined,
  }),
  loaderDeps: ({ search }) => ({
    id: search.id,
    sub: search.sub,
    origin: search.origin,
  }),
  loader: ({ deps }) => loadForkOptions(deps.id, deps.sub, deps.origin),
  component: () => (
    <ForkPage id={fork.useSearch().id} options={fork.useLoaderData()} />
  ),
});
const access = createRoute({ getParentRoute: () => rootRoute, path: '/access', loader: () => preloadView(listViews.authorizations), component: AuthorizationsPage });
const more = createRoute({
  getParentRoute: () => rootRoute,
  path: '/more',
  component: MorePage,
});
// A page an enabled Studio extension owns (docs/extensions.md).
const extensionPage = createRoute({
  getParentRoute: () => rootRoute,
  path: '/ext/$name',
  component: () => <ExtensionPage name={extensionPage.useParams().name} />,
});
const syntax = createRoute({
  getParentRoute: () => rootRoute,
  path: '/syntax',
  component: SyntaxPage,
});
const components = createRoute({
  getParentRoute: () => rootRoute,
  path: '/components',
  component: ComponentLibraryPage,
});
export const router = createRouter({
  routeTree: rootRoute.addChildren([
    compose,
    reading,
    article,
    edit,
    settings,
    setup,
    access,
    subs,
    hoppers,
    hopper,
    mentions,
    updates,
    signalsPage,
    fork,
    more,
    syntax,
    components,
    extensionPage,
  ]),
  basepath,
  trailingSlash: 'never',
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
});
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
createRoot(document.getElementById('studio-root')!).render(
  <>
    <RouterProvider router={router} />
    <SheetHost />
  </>,
);
// Installable PWA: the worker caches only the shell's static assets (see
// studioServiceWorker in src/spa.ts). Its scope is the studio base itself,
// which the Worker allows with Service-Worker-Allowed.
if ('serviceWorker' in navigator)
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${basepath}/sw.js`, { scope: basepath })
      .catch(() => {});
  });
