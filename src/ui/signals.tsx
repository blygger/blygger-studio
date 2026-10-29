// The signals page (more → signals, 0.25.0): the owner's thumbs and the
// private interaction log (src/interactions.ts), indexed in one place. This is
// what makes the thumbs load-bearing: a future feed agent ranks new items from
// a prompt plus this record. Nothing here is ever published.
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { Interaction } from '../../sdk/dist/browser.js';
import { useLiveInfiniteQuery, useLiveQuery, eq } from '@tanstack/react-db';
import { formatDateIn } from '../dates.ts';
import { thumbs, interactions, signalSummary } from './data.ts';
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
  const totals = useLiveQuery(q => q.from({ summary: signalSummary }).findOne()).data;
  const count = (view: View) => totals?.[view];
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
      <Tabs label="signals view" value={view} onValueChange={(value) => setView(value as View)}>
        {VIEWS.map((v) => (
          <Tab key={v} value={v}>
            {v}
            {count(v) !== undefined ? <span className="n">{count(v)}</span> : null}
          </Tab>
        ))}
      </Tabs>
      {view === 'activity' ? <ActivitySignals when={when} /> : <ThumbSignals key={view} view={view} when={when} />}
    </>
  );
}

function ThumbSignals({ view, when }: { view: 'liked' | 'disliked'; when: (iso: string) => string }) {
  const thumbRows = useLiveInfiniteQuery(q => q.from({ thumb: thumbs })
    .where(({ thumb }) => eq(thumb.thumb, view === 'disliked' ? -1 : 1)).orderBy(({ thumb }) => thumb.orderKey, { direction: 'asc', stringSort: 'lexical' }), { pageSize: PAGE });
  const error = thumbRows.isLoadingError || thumbRows.isCrashed || thumbRows.isSyncError
    ? new Error('Could not load signals.') : undefined;
  return (
    <>
      <Failure error={error} />
      {thumbRows.isLoading ? (
        <p className="h-hint">Loading…</p>
      ) : thumbRows.data.length ? (
        <ul className="nav-list signals-list">
          {thumbRows.data.map((t) => (
            <li key={`${t.origin}|${t.remoteId}`}>
              <div className="signal-row">
                <span className="ml">
                  <Target label={t.label} origin={t.origin} remoteId={t.remoteId} subscriptionId={t.subscriptionId} />
                  <span className="md">
                    {host(t.origin)} · {when(t.at)}
                  </span>
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : !error ? (
        <p className="h-hint">Nothing {view} yet. Use 👍 and 👎 on reading entries.</p>
      ) : null}
      {thumbRows.hasNextPage ? <Button disabled={thumbRows.isFetchingNextPage} onClick={() => void thumbRows.fetchNextPage()}>load more {view} items</Button> : null}
    </>
  );
}

function ActivitySignals({ when }: { when: (iso: string) => string }) {
  const activity = useLiveInfiniteQuery(q => q.from({ interaction: interactions })
    .orderBy(({ interaction }) => interaction.orderKey, { direction: 'asc', stringSort: 'lexical' }), { pageSize: PAGE });
  const error = activity.isLoadingError || activity.isCrashed || activity.isSyncError
    ? new Error('Could not load signals.') : undefined;
  return (
    <>
      <Failure error={error} />
      {activity.isLoading ? (
        <p className="h-hint">Loading…</p>
      ) : activity.data.length ? (
        <>
          <ul className="nav-list signals-list">
            {activity.data.map((r) => (
              <li key={r.id} data-kind={r.kind}>
                <div className="signal-row">
                  <span className="ml">
                    <Target label={r.label} origin={r.origin} remoteId={r.remoteId} subscriptionId={r.subscriptionId} />
                    <span className="md">
                      {KIND_LABELS[r.kind]}
                      {r.hopperName ? ` “${r.hopperName}”` : ''}
                      {r.ownItemId ? (
                        <>
                          {' '}
                          in{' '}
                          <Link to="/edit/$id" params={{ id: r.ownItemId }}>
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
          {activity.hasNextPage ? <Button disabled={activity.isFetchingNextPage} onClick={() => void activity.fetchNextPage()}>load more activity</Button> : null}
        </>
      ) : !error ? (
        <p className="h-hint">No activity yet.</p>
      ) : null}
    </>
  );
}
