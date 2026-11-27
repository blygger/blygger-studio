/*
 * The Agentic feed tab: the edition an assistant wrote (src/agentic.ts,
 * blygger-spec docs/agentic-feed-plan.md), drawn as a digest in sections like
 * a daily paper. The assistant chooses and words; every word it wrote is shown
 * as its own and marked as generated. The entries themselves are the reader's
 * own reading entries, linked to their full view.
 */
import { SourceName } from './source-name.tsx';
import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { BlyggerApi, unwrap } from '../../sdk/dist/browser.js';
import { client } from './data.ts';
import { Failure, Html, useSettings } from './components.tsx';
import { formatDateIn } from '../dates.ts';

type Edition = Awaited<ReturnType<typeof fetchEdition>>;
type Layout = NonNullable<Edition['layout']>;
type Section = Layout['sections'][number];
type Placed = Section['entries'][number];

/** The feed this tab shows; the only one until the Studio offers more (plan §3.3). */
const FEED = 'default';
const fetchEdition = (signal?: AbortSignal) => unwrap(BlyggerApi.getAgentic({ client, path: { feed: FEED }, signal }));

/** The edition, re-read every 15 s while the tab is open and whenever the window regains focus. */
function useEdition() {
  const [edition, setEdition] = useState<Edition>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    const controller = new AbortController();
    const load = () => fetchEdition(controller.signal).then((e) => { setEdition(e); setError(undefined); }, (e) => { if (!controller.signal.aborted) setError(e); });
    void load();
    const timer = setInterval(() => void load(), 15_000);
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, []);
  return { edition, error, setEdition };
}

const text = (html: string) => new DOMParser().parseFromString(html, 'text/html').body;
function titleOf(html: string) {
  const first = text(html).firstElementChild;
  return first && /^H[1-6]$/.test(first.tagName) ? (first.textContent ?? '').trim() : '';
}
/** The opening words, after the title heading when there is one, since the headline already says it. */
function excerptOf(html: string) {
  const body = text(html);
  const first = body.firstElementChild;
  if (first && /^H[1-6]$/.test(first.tagName)) first.remove();
  return (body.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 280);
}

/** Words the assistant wrote: always marked as its own and as generated. */
function Said({ children, as: Tag = 'p', className }: { children: string; as?: 'p' | 'span' | 'h3' | 'h4'; className?: string }) {
  return (
    <Tag className={['assistant-said', className].filter(Boolean).join(' ')} data-generated="assistant">
      {children}
    </Tag>
  );
}

function EntryCard({ placed, also }: { placed: Placed; also: Placed[] }) {
  const settings = useSettings();
  const entry = placed.entry;
  const imported = entry.imported;
  const sub = imported ? imported.subscriptionId : '~own';
  const id = imported ? imported.remoteId : entry.own?.id ?? '';
  const ownTitle = titleOf(entry.contentHtml);
  const present = placed.present ?? 'excerpt';
  return (
    <article className={`edition-entry present-${present}`} data-key={entry.key}>
      <Link className="edition-headline" to="/reading/$sub/$id" params={{ sub, id }}>
        {placed.headline ? <Said as="span">{placed.headline}</Said> : ownTitle || excerptOf(entry.contentHtml).slice(0, 90) || 'untitled'}
      </Link>
      <p className="edition-byline">
        <SourceName entry={entry} className="" /> · {formatDateIn(entry.displayAt, settings?.timezone || 'UTC')}
        {placed.version && imported && imported.version > placed.version ? ' · changed since the assistant read it' : ''}
      </p>
      {placed.summary ? <Said className="edition-summary">{placed.summary}</Said> : null}
      {present === 'full' ? <div className="content entry-body edition-body"><Html html={entry.contentHtml} /></div> : null}
      {present === 'excerpt' && !placed.summary ? <p className="edition-excerpt">{excerptOf(entry.contentHtml)}</p> : null}
      {placed.reason ? <Said className="edition-reason">{placed.reason}</Said> : null}
      {also.length ? (
        <ul className="edition-also" aria-label="also in this group">
          {also.map((other) => {
            const o = other.entry;
            const oSub = o.imported ? o.imported.subscriptionId : '~own';
            const oId = o.imported ? o.imported.remoteId : o.own?.id ?? '';
            return (
              <li key={o.key}>
                <Link to="/reading/$sub/$id" params={{ sub: oSub, id: oId }}>
                  {other.headline ?? (titleOf(o.contentHtml) || excerptOf(o.contentHtml).slice(0, 90))}
                </Link>
                <span className="edition-byline"> · <SourceName entry={o} className="" /></span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </article>
  );
}

/** A section's entries with each group gathered under its first entry; folded entries join the group above them. */
function grouped(entries: Placed[]): { lead: Placed; also: Placed[] }[] {
  const out: { lead: Placed; also: Placed[] }[] = [];
  const byGroup = new Map<string, { lead: Placed; also: Placed[] }>();
  for (const placed of entries) {
    const group = placed.group ? byGroup.get(placed.group) : undefined;
    if (group) group.also.push(placed);
    else if (placed.present === 'folded' && out.length) out[out.length - 1].also.push(placed);
    else {
      const slot = { lead: placed, also: [] as Placed[] };
      out.push(slot);
      if (placed.group) byGroup.set(placed.group, slot);
    }
  }
  return out;
}

function EditionSection({ section }: { section: Section }) {
  return (
    <section className={`edition-section kind-${section.kind}`} aria-label={section.title}>
      <Said as="h3" className="edition-section-h">{section.title}</Said>
      {section.note ? <Said className="edition-note">{section.note}</Said> : null}
      <div className="edition-entries">
        {grouped(section.entries).map(({ lead, also }) => <EntryCard key={lead.entry.key} placed={lead} also={also} />)}
      </div>
    </section>
  );
}

/** Regenerate now (session 90): the built-in digest writes a fresh edition on request. */
function Regenerate({ onDone }: { onDone: (edition: Edition) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const run = () => {
    setBusy(true);
    setError(undefined);
    unwrap(BlyggerApi.regenerateAgentic({ client, path: { feed: FEED } })).then(onDone, setError).finally(() => setBusy(false));
  };
  return (
    <p className="edition-regenerate">
      <button type="button" className="btn" onClick={run} disabled={busy}>{busy ? 'Regenerating…' : 'Regenerate now'}</button>
      {error ? <Failure error={error} /> : null}
    </p>
  );
}

export function AgenticFeed() {
  const settings = useSettings();
  const { edition, error, setEdition } = useEdition();
  if (error) return <Failure error={error} />;
  if (settings?.agenticDriver === 'off')
    return (
      <div className="empty lens-placeholder">
        <span className="em" aria-hidden="true">✦</span>
        <strong>The Agentic feed is off.</strong> Turn it on, or hide this tab, in <Link to="/settings" hash="ai-feed">Settings</Link>.
      </div>
    );
  if (!edition) return null;
  const resident = settings?.agenticDriver === 'resident';
  const layout = edition.layout;
  if (!layout || !layout.sections.length)
    return (
      <div className="empty lens-placeholder">
        <span className="em" aria-hidden="true">✦</span>
        <strong>No edition yet.</strong>{' '}
        {resident
          ? 'The built-in digest finds nothing to put in it yet: no long new posts and no conversations in the last day.'
          : <>An external agent with a token writes it (<code>PUT /api/agentic/default</code>), or choose the built-in digest in <Link to="/settings" hash="ai-feed">Settings</Link>.</>}
        {resident ? <Regenerate onDone={setEdition} /> : null}
      </div>
    );
  return (
    <div className="edition">
      <header className="edition-masthead">
        <Said as="h3" className="edition-title">{layout.title ?? 'Your edition'}</Said>
        <p className="edition-meta">
          by {layout.agent.name}
          {layout.agent.model ? ` (${layout.agent.model})` : ''}
          {layout.generatedAt ? ` · ${formatDateIn(layout.generatedAt, settings?.timezone || 'UTC')}` : ''}
          <span className="edition-badge" title="Headlines, summaries, notes and reasons in this edition were written by the assistant"> ✦ written by your assistant</span>
        </p>
        {layout.lede ? <Said className="edition-lede">{layout.lede}</Said> : null}
        {resident ? <Regenerate onDone={setEdition} /> : null}
        {edition.draft ? (
          <p className="edition-thread">
            <Link to="/edit/$id" params={{ id: edition.draft.id }}>Open as a thread</Link>
            <span className="hint"> a private draft until you publish it</span>
          </p>
        ) : null}
      </header>
      {layout.sections.map((section, i) => <EditionSection key={`${i}:${section.title}`} section={section} />)}
    </div>
  );
}
