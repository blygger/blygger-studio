// Studio extensions, UI side (docs/extensions.md). What these pin:
//   1. Off is invisible: with no extension enabled — none compiled, or
//      compiled and switched off — every slot renders nothing and adds no
//      ⋯ row, so the reference Studio's markup is unchanged.
//   2. A broken extension breaks only itself: its slot renders nothing and the
//      failure is logged under its name.
//   3. An extension's UI imports only the extension surface, React, the SDK
//      and its own files — never the Studio's internals.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DraftCounterSlot, EntryBylineSlot, EntrySheetSlot, ExtensionBoundary, entryActionRows, enabledExtensions, menuPlacement } from '../src/ui/extensions.tsx';
import type { DraftCounterContext, EntryContext, MenuZone, StudioExtension } from '../src/ui/extension-api.ts';
import { extension as example } from '../extensions/example/ui/index.tsx';

afterEach(() => vi.restoreAllMocks());

const entry = { key: 'own:x', source: 'own', kind: 'fragment', withdrawn: false, l0: false, contentHtml: '<p>x</p>', displayAt: '2026-10-01T00:00:00Z', own: { id: 'x', kind: 'fragment', withdrawn: false, updated: '2026-10-01T00:00:00Z', contentHtml: '<p>x</p>' } } as EntryContext['entry'];
const context = (): EntryContext => ({
  entry,
  id: 'x',
  client: {} as EntryContext['client'],
  openDraft: async () => {},
  navigate: async () => {},
  run: async () => {},
  actions: {},
  openSheet: () => {},
});
const html = (element: ReactElement) => renderToStaticMarkup(element);
const byline = (extensions: readonly StudioExtension[]) => html(createElement(EntryBylineSlot, { extensions, context }));
const counterContext: DraftCounterContext = {
  client: {} as DraftCounterContext['client'],
  openDraft: async () => {},
  navigate: async () => {},
  run: async () => {},
  text: 'x',
  item: { id: 'x', kind: 'thread', status: 'draft', version: 0, revision: 1 },
};
const draftCounter = (extensions: readonly StudioExtension[]) => html(createElement(DraftCounterSlot, { extensions, context: counterContext }));
const broken: StudioExtension = {
  name: 'broken',
  label: 'Broken',
  description: 'Throws from every slot.',
  entryByline: () => {
    throw new Error('byline exploded');
  },
  entryActions: () => {
    throw new Error('actions exploded');
  },
};

test('menu zones: a page gets the zone it asks for or a lower one, never a higher one', () => {
  const page = { title: 'page', component: () => null };
  const asks = (name: string, zone?: MenuZone): StudioExtension => ({ name, label: name, description: name, page: { ...page, mainMenu: { icon: '◇', ...(zone ? { zone } : {}) } } });
  const plain: StudioExtension = { name: 'plain', label: 'plain', description: 'plain', page };
  const names = (list: StudioExtension[]) => list.map((extension) => extension.name);
  const place = (list: StudioExtension[]) => {
    const menu = menuPlacement(list);
    return { top: names(menu.top), visible: names(menu.visible), hidden: names(menu.hidden) };
  };

  // Nobody asks: every page is in More.
  expect(place([])).toEqual({ top: [], visible: [], hidden: [] });
  expect(place([plain, example])).toEqual({ top: [], visible: [], hidden: ['plain', 'example'] });
  // #133's form, with no zone, means visible; the first in compiled order wins it.
  expect(place([plain, asks('a'), asks('b')])).toEqual({ top: [], visible: ['a'], hidden: ['plain', 'b'] });
  expect(place(enabledExtensions([asks('a'), asks('b')], ['b']))).toEqual({ top: [], visible: ['b'], hidden: [] });
  expect(place(enabledExtensions([asks('a')], []))).toEqual({ top: [], visible: [], hidden: [] });
  // Asking for hidden is the same as not asking.
  expect(place([asks('h', 'hidden')])).toEqual({ top: [], visible: [], hidden: ['h'] });
  // Top and visible are separate places.
  expect(place([asks('v'), asks('t', 'top')])).toEqual({ top: ['t'], visible: ['v'], hidden: [] });
  // A full top moves the second asker down to visible, if visible has room.
  expect(place([asks('t1', 'top'), asks('t2', 'top')])).toEqual({ top: ['t1'], visible: ['t2'], hidden: [] });
  // A page that asked for visible keeps it over one moved down from top.
  expect(place([asks('t1', 'top'), asks('t2', 'top'), asks('v')])).toEqual({ top: ['t1'], visible: ['v'], hidden: ['t2'] });
  // Never up: an empty top stays empty when only visible is asked for.
  expect(place([asks('v1'), asks('v2')])).toEqual({ top: [], visible: ['v1'], hidden: ['v2'] });

  const menu = menuPlacement([asks('t1', 'top'), asks('t2', 'top'), asks('v'), plain]);
  expect(['t1', 't2', 'v', 'plain'].map((name) => menu.zoneOf(menu.top.concat(menu.visible, menu.hidden).find((extension) => extension.name === name)!))).toEqual(['top', 'hidden', 'visible', 'hidden']);
});

test('extensions start off: nothing enabled means nothing selected, compiled or not', () => {
  expect(enabledExtensions([], undefined)).toEqual([]);
  expect(enabledExtensions([example], undefined)).toEqual([]);
  expect(enabledExtensions([example], [])).toEqual([]);
  expect(enabledExtensions([example], ['some-other'])).toEqual([]);
  expect(enabledExtensions([example], ['example'])).toEqual([example]);
});

test('with none enabled, every slot renders nothing and the ⋯ sheet gains no row', () => {
  for (const compiled of [[], [example]]) {
    const extensions = enabledExtensions(compiled, []);
    expect(byline(extensions)).toBe('');
    expect(draftCounter(extensions)).toBe('');
    expect(entryActionRows(extensions, context)).toEqual([]);
  }
  expect(html(createElement(EntrySheetSlot, { sheet: null, close: () => {} }))).toBe('');
});

test('an enabled extension fills its slots', () => {
  expect(byline([example])).toContain('data-extension="example"');
  expect(draftCounter([example])).toContain('thread');
  const rows = entryActionRows([example], context);
  expect(rows.map((row) => row.label)).toEqual(['example']);
  const opened: string[] = [];
  const rowsWithSheet = entryActionRows([example], () => ({ ...context(), openSheet: () => void opened.push('sheet') }));
  rowsWithSheet[0].onSelect!();
  expect(opened).toEqual(['sheet']);
});

test('a throwing entryActions or onSelect is contained and logged under its name', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(entryActionRows([broken, example], context).map((row) => row.label)).toEqual(['example']);
  expect(log.mock.calls[0][0]).toContain('"broken"');
  const throwsOnSelect: StudioExtension = { ...example, name: 'clumsy', entryActions: () => [{ label: 'boom', onSelect: () => { throw new Error('select exploded'); } }] };
  expect(() => entryActionRows([throwsOnSelect], context)[0].onSelect!()).not.toThrow();
  expect(log.mock.calls.at(-1)![0]).toContain('"clumsy"');
});

test('the slot boundary renders nothing once its extension throws, and names it', () => {
  // Error boundaries run only in a browser renderer; the browser suite covers
  // the live path. Here: the boundary's own contract, method by method.
  expect(ExtensionBoundary.getDerivedStateFromError()).toEqual({ failed: true });
  const boundary = new ExtensionBoundary({ name: 'broken', slot: 'entryByline', children: 'content' });
  expect(boundary.render()).toBe('content');
  boundary.state = { failed: true };
  expect(boundary.render()).toBeNull();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  boundary.componentDidCatch(new Error('byline exploded'), { componentStack: '' });
  expect(log.mock.calls[0][0]).toContain('"broken" failed in entryByline');
});

// Every import in an extension's UI is one of these, or a file in its own directory.
const ALLOWED = [/^react(\/.*)?$/, /^(\.\.\/){3}src\/ui\/extension-api\.ts$/, /^(\.\.\/){3}sdk\/dist\/browser\.js$/];
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(tsx?|css)$/.test(name) ? [path] : [];
  });
}
test("an extension's UI imports only the extension surface, React, the SDK and its own files", () => {
  const roots = readdirSync('extensions').filter((name) => statSync(join('extensions', name)).isDirectory());
  expect(roots).toContain('example');
  for (const name of roots) {
    for (const file of files(join('extensions', name, 'ui'))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g)) {
        const spec = match[1] ?? match[2];
        const local = spec.startsWith('./') || (spec.startsWith('../') && !spec.startsWith('../../'));
        expect(local || ALLOWED.some((pattern) => pattern.test(spec)), `${file} imports ${spec}`).toBe(true);
      }
    }
  }
});
