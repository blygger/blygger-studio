// The signals page (more → signals, 0.25.0): the owner's thumbs and the
// private interaction log (src/interactions.ts), indexed in one place. This is
// what makes the thumbs load-bearing: a future feed agent ranks new items from
// a prompt plus this record. Nothing here is ever published.
import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { Interaction, Thumb } from '../../sdk/dist/browser.js';
import { BlyggerApi, unwrap } from '../../sdk/dist/browser.js';
import { formatDateIn } from '../dates.ts';
import { client } from './data.ts';
import { Button, Failure, useChrome, useSettings } from './components.tsx';
import { Tab, Tabs } from './primitives.tsx';

const VIEWS = ['liked', 'disliked', 'activity'] as const;
type View = (typeof VIEWS)[number];
const PAGE = 50;

const KIND_LABELS: Record<Interaction['kind'], string> = {
  thumb_up: '👍 liked',
  thumb_down: '👎 disliked',
  thumb_clear: 'cleared a thumb',
  hopper_add: 'added to hopper',
  hopper_remove: 'removed from hopper',
  stub: 'responded with a stub',
  fork: 'forked',
  quote: 'quoted',
};

const host = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/** Where a target can be read: its subscription's timeline, when we still follow it. */
function Target({ label, origin, remoteId, subscriptionId }: { label: string | null; origin: string; remoteId: string; subscriptionId: string | null }) {
  const text = label || `${host(origin)} · ${remoteId.slice(0, 8)}`;
  return subscriptionId ? (
    <Link to="/reading" search={{ sub: subscriptionId, offset: 0 }}>
      {text}
    </Link>
  ) : (
    <span>{text}</span>
  );
}

export function SignalsPage() {
  useChrome({ framed: false });
  const settings = useSettings();
  const when = (iso: string) => formatDateIn(iso, settings?.timezone || 'UTC');
  const [view, setView] = useState<View>('liked');
  const [thumbs, setThumbs] = useState<Thumb[]>();
  const [log, setLog] = useState<{ items: Interaction[]; total: number; offset: number }>();
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    let live = true;
    unwrap(BlyggerApi.listThumbs({ client }))
      .then((r) => live && setThumbs(r.items))
      .catch((e) => live && setError(e));
    return () => {
      live = false;
    };
  }, []);
  const loadLog = (offset: number) =>
    unwrap(BlyggerApi.listInteractions({ client, query: { offset, limit: PAGE } }))
      .then((r) => setLog({ items: r.items, total: r.total, offset }))
      .catch(setError);
  useEffect(() => {
    if (view === 'activity' && !log) void loadLog(0);
  }, [view]);
  const liked = (thumbs ?? []).filter((t) => t.thumb === 1);
  const disliked = (thumbs ?? []).filter((t) => t.thumb === -1);
  const count = (v: View) => (v === 'liked' ? liked.length : v === 'disliked' ? disliked.length : log?.total);
  const shown = view === 'liked' ? liked : disliked;
  return (
    <>
      <Link className="back-link" to="/more">
        ← more
      </Link>
      <h2 className="view-h">signals</h2>
      <p className="view-sub signals-note">
        A private record of what you have liked, disliked, collected in hoppers
        and responded to. It is never published. A future feed agent will read it,
        with the prompt you set in Settings, to sort your Smart Feed.
      </p>
      <Failure error={error} />
      <Tabs label="signals view">
        {VIEWS.map((v) => (
          <Tab key={v} selected={view === v} onClick={() => setView(v)}>
            {v}
            {count(v) !== undefined ? <span className="n">{count(v)}</span> : null}
          </Tab>
        ))}
      </Tabs>
      {view !== 'activity' ? (
        thumbs === undefined ? (
          <p className="h-hint">Loading…</p>
        ) : shown.length ? (
          <ul className="nav-list signals-list">
            {shown.map((t) => (
              <li key={`${t.origin}|${t.remote_id}`}>
                <div className="signal-row">
                  <span className="ml">
                    <Target label={t.label} origin={t.origin} remoteId={t.remote_id} subscriptionId={t.subscription_id} />
                    <span className="md">
                      {host(t.origin)} · {when(t.at)}
                    </span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="h-hint">Nothing {view} yet. Use 👍 and 👎 on reading entries.</p>
        )
      ) : log === undefined ? (
        <p className="h-hint">Loading…</p>
      ) : log.items.length ? (
        <>
          <ul className="nav-list signals-list">
            {log.items.map((r) => (
              <li key={r.id} data-kind={r.kind}>
                <div className="signal-row">
                  <span className="ml">
                    <Target label={r.label} origin={r.origin} remoteId={r.remote_id} subscriptionId={r.subscription_id} />
                    <span className="md">
                      {KIND_LABELS[r.kind]}
                      {r.hopper_name ? ` “${r.hopper_name}”` : ''}
                      {r.own_item_id ? (
                        <>
                          {' '}
                          in{' '}
                          <Link to="/edit/$id" params={{ id: r.own_item_id }}>
                            your item
                          </Link>
                        </>
                      ) : null}{' '}
                      · {host(r.origin)} · {when(r.at)}
                      {r.backfilled ? ' · from earlier records' : ''}
                    </span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <div className="pager">
            <Button className="btn btn-ghost" disabled={log.offset === 0} onClick={() => void loadLog(Math.max(0, log.offset - PAGE))}>
              ← newer
            </Button>
            <Button className="btn btn-ghost" disabled={log.offset + PAGE >= log.total} onClick={() => void loadLog(log.offset + PAGE)}>
              older →
            </Button>
          </div>
        </>
      ) : (
        <p className="h-hint">No activity yet.</p>
      )}
    </>
  );
}
