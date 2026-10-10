// The extensions releases carry (extensions.json): reading-time and inspect.
//   1. What ships is browser-only. An extension with a server half adds routes
//      under /api/ext/, and those stay a deliberate operator build.
//   2. reading-time counts words, and Han/kana/Hangul characters, from the
//      entry's HTML, and says nothing when there is nothing to read.
//   3. inspect shows our stored record with bodies elided and *_json parsed.
import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EntryBylineSlot, entryActionRows } from '../src/ui/extensions.tsx';
import type { EntryContext } from '../src/ui/extension-api.ts';
import { extension as readingTimeExtension } from '../extensions/reading-time/ui/index.tsx';
import { extension as inspect } from '../extensions/inspect/ui/index.tsx';
import { formatMinutes, readingTime } from '../extensions/reading-time/ui/count.ts';
import { shapeRecord, summary } from '../extensions/inspect/ui/shape.ts';

// The catalog is read as text, not imported: it also imports every extension's
// contract routes, which pull the Worker's types into this browser-typed suite.
const EXTENSIONS = JSON.parse(/export const EXTENSIONS = (\[[^\]]*\]) as const;/.exec(readFileSync('extensions/catalog.ts', 'utf8'))![1]) as string[];

test('releases carry only catalogued, browser-only extensions', () => {
  expect(EXTENSIONS).toContain('reading-time');
  const shipped = (JSON.parse(readFileSync('extensions.json', 'utf8')) as { compile: string[] }).compile;
  expect(shipped).toEqual(['inspect', 'reading-time']);
  for (const name of shipped) {
    expect(EXTENSIONS).toContain(name);
    expect(existsSync(`extensions/${name}/server.ts`), `${name} has a server half and cannot ship in releases`).toBe(false);
    expect(existsSync(`extensions/${name}/contract.ts`), `${name} declares routes and cannot ship in releases`).toBe(false);
  }
});

test('reading time counts words from HTML, and CJK characters separately', () => {
  const words = Array.from({ length: 460 }, (_, i) => `word${i}`).join(' ');
  expect(readingTime(`<p>${words}</p>`)).toMatchObject({ words: 460, cjk: 0, minutes: 2 });
  // Tags, entities, scripts and styles are not words; an apostrophe or hyphen does not split one.
  expect(readingTime('<p>It’s <em>well-known</em>&nbsp;now</p><script>var a = 1</script><style>p{}</style>').words).toBe(3);
  expect(readingTime('<p>日本語の文章</p>')).toMatchObject({ words: 0, cjk: 6 });
  expect(readingTime('<p>Blygger 日本</p>')).toMatchObject({ words: 1, cjk: 2 });
  expect(formatMinutes(0)).toBe('');
  expect(formatMinutes(0.2)).toBe('< 1 min');
  expect(formatMinutes(3.6)).toBe('4 min');
});

const entryContext = (contentHtml: string, imported = false): EntryContext => ({
  entry: { key: 'own:x', source: imported ? 'imported' : 'own', kind: 'fragment', withdrawn: false, l0: false, contentHtml, displayAt: '2026-10-01T00:00:00Z' } as EntryContext['entry'],
  id: 'x',
  imported: imported ? { subscriptionId: 's', remoteId: 'x' } : undefined,
  client: {} as EntryContext['client'],
  openDraft: async () => {},
  navigate: async () => {},
  run: async () => {},
  actions: {},
  openSheet: () => {},
});

test('the reading-time byline shows minutes with the count on hover, and nothing for an empty entry', () => {
  const html = (contentHtml: string) => renderToStaticMarkup(createElement(EntryBylineSlot, { extensions: [readingTimeExtension], context: () => entryContext(contentHtml) }));
  expect(html('<p>one two three</p>')).toBe('<span data-extension="reading-time" title="3 words">· &lt; 1 min</span>');
  expect(html('')).toBe('');
});

test('inspect adds one ⋯ row that opens its own sheet', () => {
  const opened: unknown[] = [];
  const rows = entryActionRows([inspect], () => ({ ...entryContext('<p>x</p>'), openSheet: (render) => void opened.push(render) }));
  expect(rows.map((row) => row.label)).toEqual(['inspect']);
  rows[0].onSelect!();
  expect(opened).toHaveLength(1);
});

test('inspect elides bodies, parses *_json columns, and summarises the reference fields', () => {
  const imported = {
    remote_id: 'abc', kind: 'thread', version: 3, state: 'current', content_hash: 'sha256-x',
    content_md: 'hello', content_html: '<p>hello</p>',
    stub_of_json: JSON.stringify({ origin: 'https://a.example/', id: 'p1', version: 2 }),
    transclusions_json: JSON.stringify([{ id: 't1' }, { id: 't2' }]),
    forked_from_json: null, media_json: 'not json',
  };
  expect(shapeRecord(imported)).toEqual({
    ...imported,
    content_md: '‹5 characters, not shown›', content_html: '‹12 characters, not shown›',
    stub_of_json: { origin: 'https://a.example/', id: 'p1', version: 2 },
    transclusions_json: [{ id: 't1' }, { id: 't2' }],
    media_json: 'not json',
  });
  expect(summary(imported)).toEqual([
    ['id', 'abc'], ['kind', 'thread'], ['version', '3'], ['state', 'current'], ['content hash', 'sha256-x'],
    ['stub of', 'https://a.example/ p1 v2'], ['transclusions', '2'],
  ]);
  const own = {
    id: 'mine', kind: 'fragment', status: 'public', version: 1, content_md: 'x',
    stub_of: { url: 'https://elsewhere.example/post' }, forked_from: null,
    published: { content_hash: 'sha256-y', content_html: '<p>x</p>', transclusions: [] },
    versions: [{ version: 1, content_md: 'x', content_html: '<p>x</p>' }],
  };
  expect(summary(own)).toEqual([
    ['id', 'mine'], ['kind', 'fragment'], ['version', '1'], ['state', 'public'], ['content hash', 'sha256-y'],
    ['stub of', 'https://elsewhere.example/post'], ['transclusions', '0'],
  ]);
  expect((shapeRecord(own) as { versions: { content_html: string }[] }).versions[0].content_html).toBe('‹8 characters, not shown›');
});
