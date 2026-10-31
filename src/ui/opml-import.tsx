/*
 * Import OPML (studio#63): pick a file, see what it lists, subscribe to it.
 * The file is parsed here, in the browser; each feed is one ordinary
 * createSubscription with `backfill: false`, sent one at a time and paced
 * under the owner's write budget (opml.ts), so the next quarter-hour poll
 * imports the archives rather than every subscribe at once. Imported
 * subscriptions stay out of the public blogroll unless the box is ticked.
 */
import { useMemo, useRef, useState } from 'react';
import { useLiveQuery } from '@tanstack/react-db';
import { BlyggerApi } from '../../sdk/dist/browser.js';
import { client, subscriptions, changed } from './data.ts';
import { Button, Failure } from './components.tsx';
import { Sheet, toast } from './sheets.tsx';
import {
  feedKey,
  parseOpml,
  retryAfterMs,
  runImport,
  subscribedKeys,
  type Attempt,
  type ImportSummary,
  type OpmlFeed,
  type RowStatus,
} from './opml.ts';

type Phase = 'pick' | 'preview' | 'running' | 'done';

function errorText(error: unknown, status: number): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return `request failed (${status})`;
}
/** One answer from the server, read for the import: created, duplicate, throttled or failed. */
async function attempt(pending: Promise<{ data?: unknown; error?: unknown; response?: Response }>): Promise<Attempt> {
  const result = await pending;
  const response = result.response;
  if (!response) return { kind: 'failed', reason: result.error instanceof Error ? result.error.message : 'network error' };
  if (response.status === 409) return { kind: 'exists', message: errorText(result.error, 409) };
  if (response.status === 429) return { kind: 'throttled', retryAfterMs: retryAfterMs(response.headers.get('Retry-After')) };
  if (!response.ok) return { kind: 'failed', reason: errorText(result.error, response.status) };
  const data = result.data;
  if (data && typeof data === 'object' && 'needsConfirm' in data) return { kind: 'failed', reason: 'the server asked for confirmation' };
  return { kind: 'ok', id: data && typeof data === 'object' && 'id' in data ? String((data as { id: unknown }).id) : undefined };
}

function statusBadge(status: RowStatus | undefined, known: boolean) {
  const state = status?.state ?? (known ? 'exists' : 'pending');
  switch (state) {
    case 'working':
      return <span className="badge badge-pencil">adding…</span>;
    case 'added':
      return <span className="badge badge-ok">added</span>;
    case 'exists':
      return <span className="badge badge-line">already subscribed</span>;
    case 'failed':
      return <span className="badge badge-alert">failed</span>;
    case 'stopped':
      return <span className="badge">not imported</span>;
    default:
      return null;
  }
}

export function OpmlImportSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const current = useLiveQuery({ query: (q) => q.from({ source: subscriptions }) }).data ?? [];
  const known = useMemo(() => subscribedKeys(current), [current]);
  const [phase, setPhase] = useState<Phase>('pick');
  const [error, setError] = useState<unknown>();
  const [fileName, setFileName] = useState('');
  const [feeds, setFeeds] = useState<OpmlFeed[]>([]);
  const [skipped, setSkipped] = useState(0);
  // Feeds already followed when the file was read: never sent, shown as such.
  const [held, setHeld] = useState<ReadonlySet<string>>(new Set());
  const [excluded, setExcluded] = useState<ReadonlySet<number>>(new Set());
  const [blogroll, setBlogroll] = useState(false);
  const [rows, setRows] = useState<Record<number, RowStatus>>({});
  const [summary, setSummary] = useState<ImportSummary>();
  const stop = useRef(false);
  const visible = useRef(open);
  visible.current = open;

  const reset = () => {
    setPhase('pick');
    setError(undefined);
    setFileName('');
    setFeeds([]);
    setSkipped(0);
    setHeld(new Set());
    setExcluded(new Set());
    setRows({});
    setSummary(undefined);
    setBlogroll(false);
  };
  const close = () => {
    // A running import keeps going behind the sheet; anything else starts over next time.
    if (phase !== 'running') reset();
    onClose();
  };
  const read = async (file: File) => {
    setError(undefined);
    try {
      const parsed = parseOpml(await file.text());
      if (!parsed.feeds.length) throw new Error('No feeds found in this file: no outline has an xmlUrl.');
      setFileName(file.name);
      setFeeds(parsed.feeds);
      setSkipped(parsed.skipped);
      setHeld(new Set(parsed.feeds.filter((feed) => known.has(feedKey(feed.xmlUrl))).map((feed) => feed.xmlUrl)));
      setExcluded(new Set());
      setRows({});
      setPhase('preview');
    } catch (error) {
      setError(error);
    }
  };
  const chosen = feeds.filter((feed, index) => !excluded.has(index) && !held.has(feed.xmlUrl)).length;
  const start = async () => {
    stop.current = false;
    setPhase('running');
    const indices = feeds.map((_, index) => index).filter((index) => !excluded.has(index));
    const list = indices.map((index) => feeds[index]);
    const result = await runImport(list, {
      known: (feed) => held.has(feed.xmlUrl),
      subscribe: (feed) =>
        attempt(BlyggerApi.createSubscription({ client, body: { url: feed.xmlUrl, confirm: true, backfill: false } })),
      afterAdd: blogroll
        ? (id) => attempt(BlyggerApi.updateSubscription({ client, path: { id }, body: { inBlogroll: true } }))
        : undefined,
      onRow: (i, status) => setRows((prev) => ({ ...prev, [indices[i]]: status })),
      shouldStop: () => stop.current,
    });
    setSummary(result);
    setPhase('done');
    void changed('subscriptions', 'reading');
    if (!visible.current) toast(`OPML import: ${result.added} added, ${result.exists} already subscribed, ${result.failed} failed`);
  };

  return (
    <Sheet open={open} onClose={close} title="import OPML" className="opml-import">
      <Failure error={error} />
      {phase === 'pick' ? (
        <>
          <p className="sheet-body">
            Choose an OPML file exported from another reader. Folders are flattened, and the
            new subscriptions stay out of your public blogroll unless you say otherwise.
          </p>
          <label className="btn btn-primary opml-pick">
            choose file…
            <input
              id="opml-file"
              type="file"
              accept=".opml,.xml,text/x-opml,text/xml,application/xml"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void read(file);
              }}
            />
          </label>
        </>
      ) : (
        <>
          <p className="opml-head">
            <strong>{fileName}</strong> · {feeds.length} feed{feeds.length === 1 ? '' : 's'}
            {held.size ? ` · ${held.size} already subscribed` : ''}
            {skipped ? ` · ${skipped} outline${skipped === 1 ? '' : 's'} skipped` : ''}
          </p>
          <ul className="opml-list" aria-label="feeds in the file">
            {feeds.map((feed, index) => {
              const isHeld = held.has(feed.xmlUrl);
              const status = rows[index];
              return (
                <li key={feed.xmlUrl} className="opml-row" data-state={status?.state ?? (isHeld ? 'exists' : 'pending')}>
                  {phase === 'preview' ? (
                    <input
                      type="checkbox"
                      aria-label={`import ${feed.title}`}
                      checked={!isHeld && !excluded.has(index)}
                      disabled={isHeld}
                      onChange={(event) => {
                        const next = new Set(excluded);
                        if (event.target.checked) next.delete(index);
                        else next.add(index);
                        setExcluded(next);
                      }}
                    />
                  ) : null}
                  <span className="opml-text">
                    <span className="opml-title">{feed.title}</span>
                    <span className="opml-url">{feed.xmlUrl}</span>
                    {status?.state === 'failed' ? <span className="opml-reason">{status.reason}</span> : null}
                    {(status?.state === 'working' || status?.state === 'added') && status.note ? (
                      <span className="opml-reason">{status.note}</span>
                    ) : null}
                  </span>
                  {statusBadge(status, isHeld)}
                </li>
              );
            })}
          </ul>
          {phase === 'preview' ? (
            <>
              <label className="check">
                <input type="checkbox" checked={blogroll} onChange={(event) => setBlogroll(event.target.checked)} />
                <span>
                  add these to my blogroll
                  <span className="hint">
                    Lists them in your public <code>blogroll.opml</code>. You can change each one later.
                  </span>
                </span>
              </label>
              <p className="hint">
                Feeds are added one at a time, about one a second. Their posts arrive with the next
                scheduled poll, within a quarter of an hour.
              </p>
              <div className="sheet-actions">
                <Button id="opml-import" className="btn btn-primary" disabled={!chosen} onClick={() => void start()}>
                  import {chosen} feed{chosen === 1 ? '' : 's'}
                </Button>
                <Button className="btn btn-ghost" onClick={reset}>
                  choose another file
                </Button>
              </div>
            </>
          ) : null}
          {phase === 'running' ? (
            <div className="sheet-actions">
              <p className="opml-progress" role="status">
                {Object.values(rows).filter((row) => row.state !== 'pending' && row.state !== 'working').length} of{' '}
                {feeds.length - excluded.size} done
              </p>
              <Button
                className="btn btn-ghost"
                onClick={() => {
                  stop.current = true;
                }}
              >
                stop after this feed
              </Button>
            </div>
          ) : null}
          {phase === 'done' && summary ? (
            <div className="opml-summary" role="status">
              <p>
                <strong>
                  {summary.added} added · {summary.exists} already subscribed · {summary.failed} failed
                  {summary.stopped ? ` · ${summary.stopped} not imported` : ''}
                </strong>
              </p>
              {summary.added ? (
                <p className="hint">Their posts arrive with the next scheduled poll, within a quarter of an hour.</p>
              ) : null}
              <div className="sheet-actions">
                <Button className="btn btn-primary" onClick={close}>
                  done
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </Sheet>
  );
}
