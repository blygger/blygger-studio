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
import { BAR_CAPACITY, DraftCounterSlot, EntryBylineSlot, EntrySheetSlot, ExtensionBoundary, barBlocks, barPlacement, barReplaces, entryActionRows, enabledExtensions, extensionContext, menuPlacement, useEditorBars, type BarHostContext, type HostContext } from '../src/ui/extensions.tsx';
import { errorLog } from '../src/ui/error-log.ts';
import type { BarRow, DraftCounterContext, EntryContext, MenuZone, StudioExtension } from '../src/ui/extension-api.ts';
import { extension as barsExample } from '../extensions/bars-example/ui/index.tsx';
import { extension as example } from '../extensions/example/ui/index.tsx';

afterEach(() => {
  vi.restoreAllMocks();
  errorLog.clear();
});

const entry = { key: 'own:x', source: 'own', kind: 'fragment', withdrawn: false, l0: false, contentHtml: '<p>x</p>', displayAt: '2026-10-01T00:00:00Z', own: { id: 'x', kind: 'fragment', withdrawn: false, updated: '2026-10-01T00:00:00Z', contentHtml: '<p>x</p>' } } as EntryContext['entry'];
const context = (): HostContext<EntryContext> => ({
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
const counterContext: HostContext<DraftCounterContext> = {
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
  // Both are in the owner's error log too, each under its extension and slot.
  expect(errorLog.entries().map((entry) => [entry.source, entry.extension, entry.slot, entry.message])).toEqual([
    ['extension', 'clumsy', 'entryActions', 'select exploded'],
    ['extension', 'broken', 'entryActions', expect.any(String)],
  ]);
});

test('run and showError hand the failure to the screen with the extension named on it', async () => {
  // The screen's run, as every host has it: catch, and show in its error line.
  const shown: unknown[] = [];
  const host = { ...context(), run: async (action: () => unknown) => { try { await action(); } catch (failure) { shown.push(failure); } } };
  const handed = extensionContext<EntryContext>({ name: 'clumsy' }, 'entryByline', host);
  await handed.run(async () => { throw new Error('fetch fell over'); });
  handed.showError('Nothing to count yet.');
  await handed.run(() => 'fine');
  await Promise.resolve();
  expect(shown.map((error) => (error as Error).message)).toEqual(['fetch fell over', 'Nothing to count yet.']);
  // The screen's banner is what logs it; the name was put on the error before it got there.
  for (const error of shown) errorLog.record(error, 'banner');
  expect(errorLog.entries().map((entry) => [entry.source, entry.extension, entry.slot, entry.message])).toEqual([
    ['banner', 'clumsy', 'entryByline', 'Nothing to count yet.'],
    ['banner', 'clumsy', 'entryByline', 'fetch fell over'],
  ]);
  // The rest of the context is the screen's, untouched.
  expect(handed.id).toBe('x');
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
  expect(errorLog.entries()[0]).toMatchObject({ source: 'extension', extension: 'broken', slot: 'entryByline', message: 'byline exploded' });
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

// Editor bars: the Studio shares two rows among the bars that ask, and the rest go to the bars menu.
const barHost: BarHostContext = {
  client: {} as BarHostContext['client'],
  openDraft: async () => {},
  navigate: async () => {},
  run: async () => {},
  text: 'x',
  shown: 'x',
  selection: () => ({ start: 1, end: 1 }),
  insert: () => {},
  replace: () => {},
  select: () => {},
};
const bars = (extensions: readonly StudioExtension[], host: BarHostContext = barHost) => {
  let owns = false;
  const Screen = () => {
    const placed = useEditorBars(extensions, host);
    owns = placed.replaced('regionToggle');
    return createElement('div', null, placed.above, createElement('hr'), placed.below);
  };
  return { markup: html(createElement(Screen)), owns };
};
const bar = (name: string, row?: BarRow, blocks?: number, extra: Partial<NonNullable<StudioExtension['editorBar']>> = {}): StudioExtension => ({
  name,
  label: name,
  description: name,
  editorBar: { label: name, ...(row ? { row } : {}), ...(blocks !== undefined ? { blocks } : {}), component: () => createElement('b', null, name), ...extra },
});

test('editor bars: each row is filled by the bars that asked for it, then by overflow from the other, then the menu', () => {
  expect(BAR_CAPACITY).toEqual({ above: 4, below: 4 });
  const placed = barPlacement([bar('a', 'above', 3), bar('b', 'above', 2), bar('c', 'below', 3), bar('d', undefined, 1), bar('e', 'below', 2)]);
  const names = (list: StudioExtension[]) => list.map((extension) => extension.name);
  // a takes 3 above; b (2) doesn't fit there; c takes 3 below; d fits above; e (2) fits neither row, then b
  // tries below (1 left) and goes to the menu too.
  expect(names(placed.above)).toEqual(['a', 'd']);
  expect(names(placed.below)).toEqual(['c']);
  expect(names(placed.menu)).toEqual(['b', 'e']);
  // A bar that doesn't fit its row takes room in the other.
  expect(names(barPlacement([bar('x', 'above', 4), bar('y', 'above', 3)]).below)).toEqual(['y']);
});

test('editor bars: a hidden bar takes no room, and blocks are a whole number from 1 to 4', () => {
  const placed = barPlacement([bar('big', 'above', 4), bar('next', 'above', 2)], ['big']);
  expect(placed.above.map((extension) => extension.name)).toEqual(['next']);
  expect(placed.placeOf(placed.bars[0])).toBeUndefined();
  expect([bar('a', 'above', 0), bar('b', 'above', 9), bar('c', 'above', 2.4), bar('d', 'above', Number.NaN), bar('e')].map(barBlocks)).toEqual([1, 4, 2, 1, 1]);
});

test('editor bars: none enabled renders nothing; a bar renders in its row with the menu button above', () => {
  expect(bars([]).markup).toBe('<div><hr/></div>');
  const { markup } = bars([bar('low', 'below')]);
  const [above, below] = markup.split('<hr/>');
  expect(above).toContain('aria-label="editor bars"');
  expect(above).not.toContain('<b>low</b>');
  expect(below).toContain('data-extension="low"');
  expect(below).toContain('<b>low</b>');
});

test('editor bars: a bar is told where it went; replacing the regions control counts only from a row', () => {
  const { markup, owns } = bars([barsExample]);
  expect(markup).toContain('data-bar-place="above"');
  expect(markup).toContain('data-blocks="2"');
  expect(owns).toBe(true);
  // Crowded out of both rows, it is in the menu, and the Studio keeps its own notice.
  const crowd = [bar('a', 'above', 4), bar('b', 'below', 4), barsExample];
  expect(bars(crowd).owns).toBe(false);
  expect(bars(crowd).markup).not.toContain('data-bar-place');
});

test('replaceable controls: the first claimant in compiled order owns the control, wherever it is placed', () => {
  const claim = (name: string, row: BarRow, blocks: number) => bar(name, row, blocks, { replaces: ['regionToggle'] });
  // first is crowded into the menu; second is in a row but lost the claim, so the Studio keeps its notice.
  const crowded = [bar('wide', 'above', 4), bar('wider', 'below', 4), claim('first', 'above', 1), claim('second', 'above', 1)];
  const placed = barPlacement(crowded);
  expect(placed.ownerOf('regionToggle')?.name).toBe('first');
  expect(barReplaces(placed, 'regionToggle', [])).toBe(false);
  // Hidden, the owner still owns it; the Studio's control stands in.
  const hidden = barPlacement([claim('first', 'above', 1), claim('second', 'above', 1)], ['first']);
  expect(hidden.ownerOf('regionToggle')?.name).toBe('first');
  expect(barReplaces(hidden, 'regionToggle', [])).toBe(false);
  // In a row and not failed, it stands in; once it fails, the Studio's control is back.
  const shown = barPlacement([claim('first', 'above', 1), claim('second', 'above', 1)]);
  expect(barReplaces(shown, 'regionToggle', [])).toBe(true);
  expect(barReplaces(shown, 'regionToggle', ['first'])).toBe(false);
  expect(barReplaces(shown, 'regionToggle', ['second'])).toBe(true);
  // No claimant, no replacement.
  expect(barReplaces(barPlacement([bar('plain', 'above', 1)]), 'regionToggle', [])).toBe(false);
});

test('replaceable controls: each bar is told what it owns, and the bars menu is labelled', () => {
  const told: Record<string, string[]> = {};
  const claimant = (name: string): StudioExtension => ({
    name, label: name, description: name,
    editorBar: { label: name, replaces: ['regionToggle'], component: ({ context }) => { told[name] = context.bar.owns; return null; } },
  });
  const { markup } = bars([claimant('first'), claimant('second')]);
  expect(told).toEqual({ first: ['regionToggle'], second: [] });
  expect(markup).toMatch(/aria-label="editor bars"[^>]*>bars<\/button>/);
});

test('a slot boundary reports the extension that failed, so a control it replaced is handed back', () => {
  const failed: string[] = [];
  const boundary = new ExtensionBoundary({ name: 'broken-bar', slot: 'editorBar', onFail: (name) => failed.push(name), children: 'content' });
  boundary.componentDidCatch(new Error('bar exploded'), { componentStack: '' });
  expect(failed).toEqual(['broken-bar']);
});
