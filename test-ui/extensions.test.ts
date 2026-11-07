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
import { DraftCounterSlot, EntryBylineSlot, EntrySheetSlot, ExtensionBoundary, entryActionRows, enabledExtensions, mainMenuPage } from '../src/ui/extensions.tsx';
import type { DraftCounterContext, EntryContext, StudioExtension } from '../src/ui/extension-api.ts';
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

test('the main menu holds one extension page: the first that asks, and none when none is on', () => {
  const page = { title: 'page', component: () => null };
  const asks = (name: string): StudioExtension => ({ name, label: name, description: name, page: { ...page, mainMenu: { icon: '◇' } } });
  const plain: StudioExtension = { name: 'plain', label: 'plain', description: 'plain', page };
  expect(mainMenuPage([])).toBeUndefined();
  expect(mainMenuPage([plain, example])).toBeUndefined();
  expect(mainMenuPage([plain, asks('a'), asks('b')])?.name).toBe('a');
  expect(mainMenuPage(enabledExtensions([asks('a'), asks('b')], ['b']))?.name).toBe('b');
  expect(mainMenuPage(enabledExtensions([asks('a')], []))).toBeUndefined();
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
