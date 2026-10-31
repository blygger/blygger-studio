/*
 * An item of a blyg you do not subscribe to, read from its own origin
 * (0.49.0): the far end of a link or a quoted layer in the reader. Nothing is
 * stored; the page says so, and offers the subscription. An origin you do
 * hold opens as an ordinary entry (addressOf); this page also catches the held
 * origin whose copy of the item is not imported, and says so.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { BlyggerApi, unwrap } from '../../sdk/dist/browser.js';
import type { PeekItem } from '../../sdk/dist/browser.js';
import { client, queryClient } from './data.ts';
import { Button, Failure, useChrome } from './components.tsx';
import { Sheet } from './sheets.tsx';
import { AddFeedForm } from './catalog.tsx';
import { ReaderBody, TrailBar, ReaderLink } from './reader-links.tsx';
import { currentTrail, visit } from './browse.ts';

/** A leading heading is the title; the rest is the body (as the reader's own split does). */
function splitHeading(html: string) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const first = parsed.body.firstElementChild;
  let title = '';
  if (first && /^H[1-6]$/.test(first.tagName)) {
    title = first.textContent?.trim() ?? '';
    first.remove();
  }
  const text = parsed.body.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  return { title: title || text.slice(0, 60), html: parsed.body.innerHTML, heading: title };
}

/** Hover and navigation share one short-lived read; peeks never poll. */
export function loadPeek(origin: string, id: string) {
  return queryClient.fetchQuery({
    queryKey: ['owner-read', 'peek', origin, id], staleTime: 30_000,
    queryFn: ({ signal }) => unwrap(BlyggerApi.peekItem({ client, query: { origin, id }, signal })),
  });
}

export function PeekPage({ origin, id }: { origin: string; id: string }) {
  useChrome({ framed: false, wide: false });
  const navigate = useNavigate();
  const [item, setItem] = useState<PeekItem>();
  const [error, setError] = useState<unknown>();
  const [subscribing, setSubscribing] = useState(false);
  useEffect(() => {
    let live = true;
    setItem(undefined);
    setError(undefined);
    loadPeek(origin, id).then(
      (got) => live && setItem(got),
      (failure) => live && setError(failure),
    );
    return () => {
      live = false;
    };
  }, [origin, id]);
  const split = useMemo(() => (item ? splitHeading(item.content_html) : undefined), [item]);
  useEffect(() => {
    if (item && split) visit({ origin, id, version: item.version, title: split.title });
    else if (error) visit({ origin, id, version: null, title: id.slice(0, 8) });
  }, [item, error]);
  const back = () => {
    if (currentTrail().stack.length > 1) window.history.back();
    else void navigate({ to: '/reading' });
  };
  const stub = item?.stub_of as { origin?: string; id?: string; url?: string } | null | undefined;
  const host = (() => {
    try {
      return new URL(origin).host;
    } catch {
      return origin;
    }
  })();
  return (
    <>
      <TrailBar back={back} />
      <Failure error={error} />
      {item && split ? (
        <article className="entry reading-article peek" data-peek>
          <div className="entry-in">
            <p className="byline">
              <span className="badge">{item.kind}</span>
              <span className="src">{host}</span>
              <span>· v{item.version}</span>
            </p>
            {item.subscription_id ? (
              <p className="peek-note" data-peek-note>
                You subscribe to this blyg, but have not imported this item. Read from its own blyg; nothing is saved.
              </p>
            ) : (
              <div className="peek-alert" role="alert" data-peek-note data-unsubscribed>
                <p>
                  <strong>You&rsquo;re not subscribed to this blyg</strong> &mdash;{' '}
                  <Button className="link-btn" data-action="subscribe-peek" onClick={() => setSubscribing(true)}>
                    subscribe?
                  </Button>
                </p>
                <p className="peek-alert-sub">Read from its own blyg; nothing is saved.</p>
              </div>
            )}
            {item.kind === 'withdrawn' ? <p className="tomb">withdrawn</p> : null}
            {stub?.id && stub.origin ? (
              <p className="stub-head">
                responds to{' '}
                <ReaderLink origin={stub.origin} id={stub.id} via="stub" data-action="open-stub-source">
                  {stub.id.slice(0, 8)} on {(() => { try { return new URL(stub.origin!).host; } catch { return stub.origin; } })()}
                </ReaderLink>
              </p>
            ) : stub?.url ? (
              <p className="stub-head">
                responds to <a href={stub.url} target="_blank" rel="noreferrer">{stub.url}</a>
              </p>
            ) : null}
            {split.heading ? <h2 className="entry-title article-title">{split.heading}</h2> : null}
            <ReaderBody html={split.html} origin={origin} className="content entry-body article-body" />
            <p className="source-link">
              <a href={item.url} target="_blank" rel="noreferrer">
                open on {host} ↗
              </a>
            </p>
          </div>
        </article>
      ) : !error ? (
        <p className="view-sub">Loading…</p>
      ) : null}
      <Sheet open={subscribing} onClose={() => setSubscribing(false)} title={`Subscribe to ${host}`}>
        <AddFeedForm initialUrl={origin} onSubscribed={() => setSubscribing(false)} />
      </Sheet>
    </>
  );
}
