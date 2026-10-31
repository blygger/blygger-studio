import { expect, test } from 'vitest';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import {
  OpmlError,
  decodeTitle,
  feedKey,
  parseOpml,
  repairEntities,
  retryAfterMs,
  runImport,
  subscribedKeys,
  type Attempt,
  type OpmlFeed,
  type ParseXml,
  type RowStatus,
  type XmlElement,
} from '../src/ui/opml.ts';

/*
 * The browser parses with DOMParser; this suite runs under node, so it hands
 * parseOpml a stand-in with DOMParser's contract: a malformed document comes
 * back carrying a <parsererror>, and an entity XML does not define (or a bare
 * `&`) makes the document malformed, as it does in the browser. The real
 * DOMParser path is driven by e2e/opml-import.spec.ts.
 */
type Node = Record<string, unknown>;
function element(node: Node): XmlElement {
  const name = Object.keys(node).find((key) => key !== ':@')!;
  const attrs = (node[':@'] ?? {}) as Record<string, string>;
  const kids = (node[name] as Node[]).filter((child) => !('#text' in child)).map(element);
  return { localName: name, getAttribute: (key) => (key in attrs ? attrs[key] : null), children: kids };
}
const BAD_ENTITY = /&(?!(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);)/;
const nodeParse: ParseXml = (text) => {
  const broken = { documentElement: null, getElementsByTagName: (name: string) => (name === 'parsererror' ? [{}] : []) };
  if (XMLValidator.validate(text) !== true || BAD_ENTITY.test(text)) return broken;
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', preserveOrder: true, processEntities: true });
  const top = (parser.parse(text) as Node[]).filter((node) => !('?xml' in node) && !('#text' in node));
  return { documentElement: top[0] ? element(top[0]) : null, getElementsByTagName: () => [] };
};
const parse = (text: string) => parseOpml(text, nodeParse);

const NESTED = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>my feeds</title></head>
  <body>
    <outline text="Tech" title="Tech">
      <outline type="rss" text="Alpha" title="Alpha" xmlUrl="https://alpha.example/feed.xml" htmlUrl="https://alpha.example/"/>
      <outline text="Deeper">
        <outline type="rss" text="Beta" xmlUrl="https://beta.example/rss"/>
      </outline>
    </outline>
    <outline text="Gamma, no type" xmlUrl="https://gamma.example/atom.xml"/>
    <outline type="atom" text="Delta" xmlUrl="https://delta.example/atom"/>
  </body>
</opml>`;

test('nested folders are flattened, in document order', () => {
  const { feeds, skipped } = parse(NESTED);
  expect(feeds.map((feed) => feed.title)).toEqual(['Alpha', 'Beta', 'Gamma, no type', 'Delta']);
  expect(feeds[0]).toEqual({ title: 'Alpha', xmlUrl: 'https://alpha.example/feed.xml', htmlUrl: 'https://alpha.example/' });
  expect(skipped).toBe(0);
});

test('an outline with an xmlUrl and no type is a feed; title falls back to text, then the host', () => {
  const { feeds } = parse(`<opml><body>
    <outline xmlUrl="https://notype.example/feed"/>
    <outline text="By text" xmlUrl="https://bytext.example/feed"/>
  </body></opml>`);
  expect(feeds).toEqual([
    { title: 'notype.example', xmlUrl: 'https://notype.example/feed' },
    { title: 'By text', xmlUrl: 'https://bytext.example/feed' },
  ]);
});

test('outlines without an xmlUrl are recursed into but never listed; other types and bad URLs are skipped', () => {
  const { feeds, skipped } = parse(`<opml><body>
    <outline text="just a folder"><outline text="empty folder"/></outline>
    <outline type="link" text="A link" url="https://link.example/"/>
    <outline type="include" text="An include" xmlUrl="https://inc.example/list.opml"/>
    <outline type="rss" text="Not http" xmlUrl="javascript:alert(1)"/>
    <outline type="rss" text="Kept" xmlUrl="https://kept.example/feed"/>
    <outline type="rss" text="Kept again" xmlUrl="http://www.kept.example/feed/"/>
  </body></opml>`);
  expect(feeds.map((feed) => feed.title)).toEqual(['Kept']);
  expect(skipped).toBe(3);
});

test('entities: XML ones decode, double-escaped titles decode, bare ampersands and HTML entities are repaired', () => {
  const escaped = parse(`<opml><body>
    <outline type="rss" text="Tom &amp; Jerry&amp;#8217;s &lt;feed&gt;" xmlUrl="https://e.example/feed?a=1&amp;b=2"/>
  </body></opml>`);
  expect(escaped.feeds[0]).toEqual({ title: 'Tom & Jerry’s <feed>', xmlUrl: 'https://e.example/feed?a=1&b=2' });

  const sloppy = parse(`<opml><body>
    <outline type="rss" text="Caf&eacute; &mdash; notes" xmlUrl="https://e.example/feed?a=1&b=2"/>
  </body></opml>`);
  expect(sloppy.feeds[0]).toEqual({ title: 'Café — notes', xmlUrl: 'https://e.example/feed?a=1&b=2' });
});

test('a malformed or non-OPML file is refused with a reason', () => {
  expect(() => parse('<opml><body><outline xmlUrl="https://x.example/"></body></opml>')).toThrow(OpmlError);
  expect(() => parse('<opml><body><outline xmlUrl="https://x.example/"></body></opml>')).toThrow(/well-formed/);
  expect(() => parse('')).toThrow(/empty/);
  expect(() => parse('<rss><channel/></rss>')).toThrow(/not an OPML file/);
  expect(() => parse('<opml><head/></opml>')).toThrow(/no <body>/);
  expect(() => parse('﻿<opml><body/></opml>')).not.toThrow();
});

test('helpers: repair, decode, keys', () => {
  expect(repairEntities('a & b &amp; &#38; &eacute;')).toBe('a &amp; b &amp; &#38; &amp;eacute;');
  expect(decodeTitle('  x&#x2014;y &unknown;  ')).toBe('x—y &unknown;');
  expect(feedKey('https://WWW.Example.com/feed/')).toBe(feedKey('http://example.com/feed'));
  expect(feedKey('https://example.com/feed?a=1')).not.toBe(feedKey('https://example.com/feed?a=2'));
  const keys = subscribedKeys([{ origin: 'https://blyg.example/', feedUrl: 'https://blyg.example/feed.xml' }]);
  expect(keys.has(feedKey('https://blyg.example/feed.xml'))).toBe(true);
  expect(keys.has(feedKey('https://blyg.example'))).toBe(true);
});

test('Retry-After: seconds, an HTTP date, or a whole window when absent', () => {
  expect(retryAfterMs('7')).toBe(7000);
  expect(retryAfterMs('Thu, 01 Jan 2026 00:01:00 GMT', Date.parse('Thu, 01 Jan 2026 00:00:30 GMT'))).toBe(30_000);
  expect(retryAfterMs(null)).toBe(60_000);
  expect(retryAfterMs('soon')).toBe(60_000);
});

const feeds: OpmlFeed[] = ['a', 'b', 'c', 'd'].map((name) => ({ title: name, xmlUrl: `https://${name}.example/feed` }));

test('the import is sequential and paced, 409 is "already subscribed", 429 waits out Retry-After', async () => {
  const log: string[] = [];
  const answers: Record<string, Attempt[]> = {
    a: [{ kind: 'ok', id: 'id-a' }],
    b: [{ kind: 'throttled', retryAfterMs: 5000 }, { kind: 'ok', id: 'id-b' }],
    c: [{ kind: 'exists', message: 'already subscribed to c' }],
    d: [{ kind: 'failed', reason: 'could not resolve this URL to a blyg or a feed' }],
  };
  let inFlight = 0;
  const rows: Record<number, RowStatus> = {};
  const summary = await runImport(feeds, {
    subscribe: async (feed) => {
      inFlight++;
      expect(inFlight).toBe(1);
      log.push(`post ${feed.title}`);
      await Promise.resolve();
      inFlight--;
      return answers[feed.title].shift()!;
    },
    sleep: async (ms) => void log.push(`sleep ${ms}`),
    onRow: (index, status) => (rows[index] = status),
    spacingMs: 1000,
  });
  expect(log).toEqual(['post a', 'sleep 1000', 'post b', 'sleep 5000', 'sleep 1000', 'post b', 'sleep 1000', 'post c', 'sleep 1000', 'post d']);
  expect(summary).toEqual({ added: 2, exists: 1, failed: 1, stopped: 0 });
  expect(rows[2]).toEqual({ state: 'exists' });
  expect(rows[3]).toEqual({ state: 'failed', reason: 'could not resolve this URL to a blyg or a feed' });
});

test('known rows send nothing, the blogroll PATCH is paced like any write, and stop leaves the rest', async () => {
  const log: string[] = [];
  let stop = false;
  const summary = await runImport(feeds, {
    known: (feed) => feed.title === 'a',
    subscribe: async (feed) => {
      log.push(`post ${feed.title}`);
      if (feed.title === 'c') stop = true;
      return { kind: 'ok', id: `id-${feed.title}` };
    },
    afterAdd: async (id) => {
      log.push(`patch ${id}`);
      return id === 'id-c' ? { kind: 'failed', reason: 'nope' } : { kind: 'ok' };
    },
    sleep: async (ms) => void log.push(`sleep ${ms}`),
    onRow: () => {},
    shouldStop: () => stop,
    spacingMs: 1000,
  });
  expect(log).toEqual(['post b', 'sleep 1000', 'patch id-b', 'sleep 1000', 'post c', 'sleep 1000', 'patch id-c']);
  expect(summary).toEqual({ added: 2, exists: 1, failed: 0, stopped: 1 });
});

test('a budget that stays exhausted fails the row after the retries, and a long Retry-After is capped', async () => {
  const waits: number[] = [];
  const rows: Record<number, RowStatus> = {};
  const summary = await runImport(feeds.slice(0, 1), {
    subscribe: async () => ({ kind: 'throttled', retryAfterMs: 3_600_000 }),
    sleep: async (ms) => void waits.push(ms),
    onRow: (index, status) => (rows[index] = status),
    maxRetries: 2,
    maxWaitMs: 90_000,
  });
  expect(waits.filter((ms) => ms === 90_000)).toHaveLength(2);
  expect(summary.failed).toBe(1);
  expect(rows[0]).toMatchObject({ state: 'failed', reason: expect.stringMatching(/rate limited/) });
});
