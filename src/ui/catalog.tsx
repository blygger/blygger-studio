import { previewFromHtml } from '../preview.ts';
import { useMemo, useState } from 'react';
import { count, useLiveQuery } from '@tanstack/react-db';
import { Link, useNavigate } from '@tanstack/react-router';
import type { Mention } from '../../sdk/dist/browser.js';
import { BlyggerApi, unwrap } from '../../sdk/dist/browser.js';
import {
  client,
  queryClient,
  subscriptions,
  hoppers,
  items,
  createDraftAction,
  changed,
  hopperDetail,
  hopperPreview,
  inbound,
  outbound,
  mentionSource,
} from './data.ts';
import {
  Button,
  Failure,
  Html,
  mount,
  publicPath,
  useChrome,
  useSettings,
  SourceLink,
} from './components.tsx';
import { sourceTitleAndUrl } from '../importer/util.ts';
import { confirm } from './sheets.tsx';
import { itemTitle } from './plain-text.ts';
import { formatDateIn } from '../dates.ts';
import { mentionQuery } from './mention-order.ts';
import './reading.css';
function useAction() {
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  return {
    error,
    busy,
    run: async (fn: () => Promise<unknown>) => {
      if (busy) return;
      setBusy(true);
      setError(undefined);
      try {
        await fn();
      } catch (error) {
        setError(error);
      } finally {
        setBusy(false);
      }
    },
  };
}
/** Subscribe to a blyg or a feed: the body of reading's ＋ sheet. */
export function AddFeedForm({ onSubscribed, initialUrl = '' }: { onSubscribed?: () => void; initialUrl?: string }) {
  const action = useAction();
  const [url, setUrl] = useState(initialUrl);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    siteMismatch?: {
      asserted: string;
      actual: string;
    };
  }>();
  const add = async (confirm = false) => {
    const result = await unwrap(
      BlyggerApi.createSubscription({ client, body: { url, confirm } }),
    );
    if ('needsConfirm' in result) setConfirmation(result);
    else {
      setConfirmation(undefined);
      setUrl('');
      // The backfill runs on the server after this reply; polling brings its
      // items in, so the sheet need not wait on the refetch.
      void changed('subscriptions', 'reading');
      onSubscribed?.();
    }
  };
  return (
    <>
      <Failure error={action.error} />
      <form
        id="add-sub-form"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(() => add());
        }}
      >
        <input
          id="add-sub-url"
          type="url"
          inputMode="url"
          aria-label="feed or blyg URL"
          placeholder="https://example.com/"
          required
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setConfirmation(undefined);
          }}
        />
        {confirmation ? null : (
          <div className="sheet-actions">
            <Button
              className="btn btn-primary"
              disabled={action.busy}
              type="submit"
            >
              {action.busy ? 'checking…' : 'subscribe'}
            </Button>
          </div>
        )}
      </form>
      {confirmation ? (
        <div id="add-sub-confirm" className="add-sub-confirm">
          <p>
            <strong>Subscribe to {confirmation.title}?</strong>
          </p>
          {confirmation.siteMismatch ? (
            <p className="mismatch">
              Site mismatch: {confirmation.siteMismatch.asserted} /{' '}
              {confirmation.siteMismatch.actual}
            </p>
          ) : null}
          <div className="sheet-actions">
            <Button
              className="btn btn-primary"
              disabled={action.busy}
              onClick={() => void action.run(() => add(true))}
            >
              {action.busy ? 'subscribing…' : 'confirm subscribe'}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
export function HoppersPage() {
  useChrome({ framed: false });
  const rows =
    useLiveQuery({
      query: (q) => q.from({ hopper: hoppers }),
    }).data ?? [];
  const action = useAction();
  const [name, setName] = useState('');
  const create = async () => {
    const hopper = await unwrap(
      BlyggerApi.createHopper({ client, body: { name } }),
    );
    await hoppers.utils.writeUpsert(hopper);
    setName('');
  };
  return (
    <>
      <h2 className="view-h">hoppers</h2>
      <Failure error={action.error} />
      <form
        className="card hopper-create"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(create);
        }}
      >
        <div className="row">
          <input
            type="text"
            aria-label="hopper name"
            placeholder="hopper name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            className="btn btn-primary"
            type="submit"
            disabled={action.busy}
          >
            create hopper
          </Button>
        </div>
      </form>
      {rows.map((hopper) => (
        <HopperCard key={hopper.id} id={hopper.id} name={hopper.name} />
      ))}
    </>
  );
}
function HopperCard({ id, name }: { id: string; name: string }) {
  const collection = useMemo(() => hopperPreview(id), [id]);
  const row = useLiveQuery({ query: (q) => q.from({ hopper: collection }) })
    .data?.[0];
  const sources =
    useLiveQuery({ query: (q) => q.from({ source: subscriptions }) }).data ??
    [];
  return (
    <div className="card hopper-row">
      <h3 className="card-h">
        <Link to="/hoppers/$id" params={{ id }}>
          {name}
        </Link>
        <span className="chev" aria-hidden="true">
          ›
        </span>
      </h3>
      {row ? (
        <>
          <p className="muted small hopper-meta">
            {row.total} items · {row.sourceCount} sources ·{' '}
            {row.hopper.public ? 'public' : 'private'}
          </p>
          {row.items.map((item) => {
            const preview = previewFromHtml(item.contentHtml);
            const source = sources.find(
              (source) => source.id === item.subscriptionId,
            );
            return (
              <p
                className="hopper-prev hopper-preview"
                key={JSON.stringify([item.subscriptionId, item.remoteId])}
              >
                {preview.title ? <strong>{preview.title} · </strong> : null}
                {preview.body}
                {source ? (
                  <small> · {source.title || source.origin}</small>
                ) : null}
              </p>
            );
          })}
          {row.total > 3 ? (
            <p className="tiny muted hopper-more">+{row.total - 3} more</p>
          ) : null}
        </>
      ) : (
        <p className="muted small">Loading preview…</p>
      )}
    </div>
  );
}
export function HopperPage({ id }: { id: string }) {
  useChrome({ framed: false });
  const collection = useMemo(() => hopperDetail(id), [id]);
  const result = useLiveQuery({
    query: (q) => q.from({ hopper: collection }),
  });
  const row = result.data?.[0];
  const ownRows =
    useLiveQuery({ query: (q) => q.from({ item: items }) }).data ?? [];
  const action = useAction();
  const navigate = useNavigate();
  const settings = useSettings();
  const [name, setName] = useState<string>();
  const [description, setDescription] = useState<string>();
  const sources =
    useLiveQuery({ query: (q) => q.from({ source: subscriptions }) }).data ??
    [];
  if (!row) return <p className="view-sub" role={result.isReady ? 'alert' : undefined}>
    {result.isReady ? 'Hopper not found.' : 'Loading hopper…'}
  </p>;
  const update = async (body: { name?: string; public?: boolean; description?: string }) => {
    await unwrap(BlyggerApi.updateHopper({ client, path: { id }, body }));
    await changed('hoppers', 'hopper', 'hopper-preview');
  };
  const remove = async () => {
    await unwrap(BlyggerApi.deleteHopper({ client, path: { id } }));
    await changed('hoppers');
    await navigate({ to: '/hoppers' });
  };
  const added = (iso: string) => {
    const time = Date.parse(iso);
    return Number.isNaN(time)
      ? iso
      : formatDateIn(iso, settings?.timezone || 'UTC');
  };
  return (
    <>
      <Link className="back-link" to="/hoppers">
        ← hoppers
      </Link>
      <h2 className="view-h">{row.hopper.name}</h2>
      <Failure error={action.error} />
      <div className="card hopper-settings">
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(() => update({ name: name ?? row.hopper.name }));
          }}
        >
          <input
            type="text"
            name="name"
            aria-label="name"
            value={name ?? row.hopper.name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button className="btn btn-ghost" type="submit" disabled={action.busy}>
            rename
          </Button>
        </form>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(() =>
              update({ description: description ?? row.hopper.description ?? '' }),
            );
          }}
        >
          <input
            type="text"
            name="description"
            aria-label="description"
            placeholder="one-line description (shown on the public page)"
            maxLength={280}
            value={description ?? row.hopper.description ?? ''}
            onChange={(e) => setDescription(e.target.value)}
          />
          <Button className="btn btn-ghost" type="submit" disabled={action.busy}>
            save
          </Button>
        </form>
        <label className="check">
          <input
            type="checkbox"
            checked={row.hopper.public}
            disabled={action.busy}
            onChange={(e) => {
              const checked = e.target.checked;
              void action.run(() => update({ public: checked }));
            }}
          />
          <span>public</span>
        </label>
        {row.hopper.public && row.hopper.slug ? (
          <p className="hint">
            Public URL:{' '}
            <a
              href={`${mount}/h/${row.hopper.slug}/`}
              target="_blank"
              rel="noreferrer"
            >
              {location.origin}
              {mount}/h/{row.hopper.slug}/
            </a>
          </p>
        ) : null}
        {row.hopper.slugFrozen ? (
          <p className="hint">
            The public URL stays fixed when you rename this hopper.
          </p>
        ) : null}
        <p className="hint">
          A public hopper gets its own page and is listed under Collections on
          your homepage and archive. It never appears in your feed.
        </p>
      </div>
      <div className="section-h">
        <span>
          {row.total} items from {row.sourceCount} sources
        </span>
      </div>
      {row.memberships.map((member) => {
        const key = JSON.stringify([member.subscriptionId, member.remoteId]);
        const removeButton = (
          <Button
            className="btn btn-ghost btn-mini"
            onClick={() =>
              void action.run(async () => {
                await unwrap(
                  BlyggerApi.removeHopperItem({
                    client,
                    path: { id, sub: member.subscriptionId, remoteId: member.remoteId },
                  }),
                );
                await changed('hopper', 'hoppers', 'hopper-preview');
              })
            }
          >
            remove
          </Button>
        );
        // One of the owner's own items (session 47; store.ts OWN_SUBSCRIPTION).
        if (member.subscriptionId === '~own') {
          const own = ownRows.find((row) => row.id === member.remoteId);
          return (
            <article className="entry reading-entry" key={key} data-own={member.remoteId}>
              <div className="entry-in">
                <p className="byline">
                  {own ? <span className="badge">{own.kind}</span> : null}
                  <span className="src">
                    {!own ? 'deleted' : own.status === 'public' ? 'yours' : own.status === 'draft' ? 'your draft, not shown publicly' : 'yours, withdrawn'}
                  </span>
                  <span>· added {added(member.addedAt)}</span>
                </p>
                {own ? (
                  <div className="entry-body content">
                    <p>
                      <strong>{itemTitle(own.contentMd)}</strong>
                    </p>
                  </div>
                ) : null}
              </div>
              <div className="entry-bar">
                <span className="spacer" />
                {own ? (
                  <Link className="btn btn-ghost btn-mini" to="/edit/$id" params={{ id: own.id }}>
                    edit
                  </Link>
                ) : null}
                {removeButton}
              </div>
            </article>
          );
        }
        const item = row.items.find(
          (item) =>
            item.subscriptionId === member.subscriptionId &&
            item.remoteId === member.remoteId,
        );
        const source = sources.find(
          (source) => source.id === member.subscriptionId,
        );
        return (
          <article className="entry reading-entry" key={key}>
            <div className="entry-in">
              <p className="byline">
                {item ? <span className="badge">{item.kind}</span> : null}
                {source ? (
                  <a
                    className="src"
                    href={source.origin}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {source.title || source.origin}
                  </a>
                ) : (
                  <span className="src">{member.subscriptionId}</span>
                )}
                <span>· added {added(member.addedAt)}</span>
              </p>
              {item?.state === 'tombstone' ? (
                <p className="tomb">
                  withdrawn by origin
                  {item.pinnedVersionRetained != null
                    ? ` · retained pinned v${item.pinnedVersionRetained}`
                    : ''}
                </p>
              ) : null}
              <div className="entry-body content">
                <Html html={item?.contentHtml || ''} />
              </div>
              <SourceLink
                url={
                  item && source
                    ? sourceTitleAndUrl({ l0: item.l0 ? 1 : 0, kind: item.kind, remote_id: item.remoteId, content_html: item.contentHtml, page: item.page }, source.origin).url
                    : undefined
                }
              />
            </div>
            <div className="entry-bar">
              <span className="spacer" />
              {item ? (
                <Button
                  className="btn btn-ghost btn-mini"
                  data-action="stub"
                  onClick={() =>
                    void action.run(async () => {
                      const draft = await unwrap(
                        BlyggerApi.createItem({
                          client,
                          body: {
                            mode: 'response',
                            source: {
                              subscriptionId: member.subscriptionId,
                              remoteId: member.remoteId,
                            },
                          },
                        }),
                      );
                      await changed('items');
                      await navigate({
                        to: '/edit/$id',
                        params: { id: draft.id },
                      });
                    })
                  }
                >
                  stub ↗
                </Button>
              ) : null}
              {removeButton}
            </div>
          </article>
        );
      })}
      <p>
        <Button
          className="btn btn-danger"
          onClick={async () => {
            if (
              await confirm({
                title: 'Delete this hopper?',
                ok: 'delete hopper',
                danger: true,
              })
            )
              void action.run(remove);
          }}
        >
          delete hopper
        </Button>
      </p>
    </>
  );
}
function MentionRow({ mention }: { mention: Mention }) {
  const action = useAction(),
    navigate = useNavigate();
  const collection = useMemo(() => mentionSource(mention.id), [mention.id]);
  const source = useLiveQuery({ query: (q) => q.from({ source: collection }) })
    .data?.[0];
  let author = mention.sourceOrigin || mention.source;
  const name = mention.sourceAuthor?.name;
  if (typeof name === 'string' && name) author = name;
  const gone = mention.status === 'gone';
  return (
    <div
      className={`mention-row ${mention.hidden ? 'hidden-row' : ''} ${gone ? 'gone' : ''}`}
    >
      <span className="rel">{mention.relation || 'mention'}</span> ·{' '}
      <a
        className="who"
        href={mention.sourcePage || mention.source}
        target="_blank"
        rel="noreferrer"
      >
        {author}
      </a>{' '}
      <span className="muted">
        · v{mention.sourceVersion ?? '?'} · first seen {mention.firstSeen}
        {gone ? ' · no longer verifies' : ''}
      </span>
      {gone ? null : (
        <div className="actions">
          <Button
            className="btn btn-ghost btn-mini"
            onClick={() =>
              void action.run(async () => {
                await unwrap(
                  BlyggerApi.updateMention({
                    client,
                    path: { id: mention.id },
                    body: { hidden: !mention.hidden },
                  }),
                );
                await changed('mentions-in');
              })
            }
          >
            {mention.hidden ? 'show on page' : 'hide from page'}
          </Button>
          {mention.sourceId && source?.holder ? (
            <Button
              className="btn btn-ghost btn-mini"
              onClick={() =>
                void action.run(async () => {
                  const draft = await unwrap(
                    BlyggerApi.createItem({
                      client,
                      body: {
                        mode: 'response',
                        source: {
                          subscriptionId: source.holder!,
                          remoteId: mention.sourceId!,
                        },
                      },
                    }),
                  );
                  await changed('items');
                  await navigate({ to: '/edit/$id', params: { id: draft.id } });
                })
              }
            >
              stub back ↗
            </Button>
          ) : mention.sourceId ? (
            source?.subscription ? (
              // Subscribed: its inspector (ⓘ on the timeline) has resync.
              <Link
                className="btn btn-ghost btn-mini subscribe-first"
                to="/reading"
                search={{ sub: source.subscription.id, offset: 0 }}
              >
                resync this source to stub back
              </Link>
            ) : (
              // Not subscribed: the sources list, whose ＋ subscribes.
              <Link
                className="btn btn-ghost btn-mini subscribe-first"
                to="/reading"
                search={{}}
              >
                subscribe to {mention.sourceOrigin} to stub back
              </Link>
            )
          ) : null}
        </div>
      )}
      <Failure error={action.error} />
    </div>
  );
}
function ResponseVisibility({ id, revision, mode, defaultShowing, disabled }: {
  id: string;
  revision: number;
  mode: 'default' | 'show' | 'hide';
  defaultShowing: boolean;
  disabled: boolean;
}) {
  const write = useMemo(() => createDraftAction(id, revision), [id, revision]);
  const action = useAction();
  return (
    <>
      <div className="field">
        <span id={`responses-${id}`}>
          Responses on this item's public page:
        </span>
        <div
          className="segmented"
          role="group"
          aria-labelledby={`responses-${id}`}
        >
          {(
            [
              [
                'default',
                `default (${defaultShowing ? 'showing' : 'hidden'})`,
              ],
              ['show', 'show'],
              ['hide', 'hide'],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              className={mode === value ? 'seg is-active' : 'seg'}
              aria-pressed={mode === value}
              disabled={disabled || action.busy}
              onClick={() =>
                void action.run(async () => {
                  if (mode === value) return;
                  await write({ type: 'update', changes: { responses: value } });
                })
              }
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
      <Failure error={action.error} />
    </>
  );
}
export function MentionsPage() {
  useChrome({ framed: false });
  const settings = useSettings();
  const groups =
    useLiveQuery({ query: (q) => mentionQuery(q, inbound, items, !!settings?.showResponsesDefault) }).data ?? [];
  const incomingStats = useLiveQuery({ query: q => q.from({ mention: inbound })
    .select(({ mention }) => ({ total: count(mention.id) })).findOne() }).data;
  const outgoingStats = useLiveQuery({ query: q => q.from({ mention: outbound })
    .select(({ mention }) => ({ total: count(mention.id) })).findOne() }).data;
  const outgoing =
    useLiveQuery({ query: (q) => q.from({ mention: outbound })
      .orderBy(({ mention }) => mention.created, 'desc').orderBy(({ mention }) => mention.id, 'asc') }).data ?? [];
  const [direction, setDirection] = useState<'inbound' | 'outbound'>(
    'inbound',
  );
  return (
    <>
      <h2 className="view-h">mentions</h2>
      <p className="view-sub mentions-note">
        Verified responses from other blygs.
      </p>
      <div className="segmented" role="group" aria-label="direction">
        {(['inbound', 'outbound'] as const).map((value) => (
          <Button
            key={value}
            className={direction === value ? 'seg is-active' : 'seg'}
            aria-pressed={direction === value}
            onClick={() => setDirection(value)}
          >
            {value}
            <span className="n">
              {value === 'inbound' ? incomingStats?.total ?? 0 : outgoingStats?.total ?? 0}
            </span>
          </Button>
        ))}
      </div>
      {direction === 'inbound' ? (
        <>
          {groups.map(({ target: id, receipts: rows, item, mode, visible, total }) => {
            return (
              <section className="card mention-group" key={id}>
                <h3 className="card-h">
                  {/* The responses are shown on the public page, so that is
                      where the heading goes; editing is a side link. */}
                  {item?.status === 'public' ? (
                    <a href={publicPath(item)} target="_blank" rel="noreferrer">
                      {item.contentMd.slice(0, 60) || id.slice(0, 8)} ↗
                    </a>
                  ) : (
                    item?.contentMd.slice(0, 60) || id.slice(0, 8)
                  )}{' '}
                  <Link className="muted small" to="/edit/$id" params={{ id }}>
                    edit
                  </Link>
                </h3>
                <p className="muted small group-meta">
                  {total} responses · {visible} on the page
                  now
                </p>
                <ResponseVisibility id={id} revision={item?.revision ?? 0} mode={mode} defaultShowing={!!settings?.showResponsesDefault} disabled={!item} />
                {rows.map((mention) => (
                  <MentionRow key={mention.id} mention={mention} />
                ))}
              </section>
            );
          })}
          {!groups.length ? (
            <div className="empty">
              <span className="em" aria-hidden="true">
                ↩
              </span>
              No verified mentions.
            </div>
          ) : null}
        </>
      ) : (
        <>
          {!settings?.siteUrl ? (
            <div className="banner banner-warn mentions-note" role="note">
              <span className="mark" aria-hidden="true">
                !
              </span>
              <div className="body">
                No site URL is set. Set it in{' '}
                <Link to="/settings">settings</Link> before relying on outbound
                delivery.
              </div>
            </div>
          ) : null}
          {outgoing.length ? (
            <div className="card">
              {outgoing.map((mention) => (
                <div className="out-row" key={mention.id}>
                  <span
                    className={`badge ${
                      mention.status === 'sent'
                        ? 'badge-ok'
                        : mention.status === 'pending'
                          ? 'badge-warn'
                          : ''
                    }`}
                  >
                    {mention.status.replaceAll('_', ' ')}
                  </span>{' '}
                  <Link to="/edit/$id" params={{ id: mention.itemId }}>
                    v{mention.version} of {mention.itemId.slice(0, 8)}…
                  </Link>
                  <div className="small muted">
                    →{' '}
                    <a className="target" href={mention.target}>
                      {mention.target}
                    </a>{' '}
                    · {mention.attempts} attempts
                    {mention.nextAttemptAt && mention.status === 'pending'
                      ? ` · retrying after ${mention.nextAttemptAt}`
                      : ''}
                  </div>
                  {mention.lastError ? (
                    <div className="small err">{mention.lastError}</div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
export function ForkPage({
  id,
  options,
}: {
  id: string;
  options: Awaited<ReturnType<typeof loadForkOptions>>;
}) {
  useChrome({ framed: false });
  const action = useAction();
  const navigate = useNavigate();
  return (
    <>
      <h2 className="view-h">
        fork <small className="mono">{id}</small>
      </h2>
      <Failure error={action.error || options.error} />
      {options.versions.length ? (
        <div className="card">
          {options.versions.map((version) => (
            <div className="kv" key={version.version}>
              <span className="vnum">v{version.version}</span>
              <span className="muted">{version.at}</span>
              <span>{version.note}</span>
              <span className="spacer" />
              <Button
                className="btn btn-primary btn-mini"
                data-action="fork"
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    const draft = await unwrap(
                      BlyggerApi.createItem({
                        client,
                        body: {
                          mode: 'fork',
                          source: {
                            origin: options.origin,
                            id,
                            version: version.version,
                          },
                        },
                      }),
                    );
                    await items.utils.writeUpsert(draft);
                    await navigate({
                      to: '/edit/$id',
                      params: { id: draft.id },
                    });
                  })
                }
              >
                fork v{version.version}
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
export function loadForkOptions(id: string, sub?: string, origin?: string) {
  return queryClient.fetchQuery({
    staleTime: 0,
    queryKey: ['fork-options', id, sub ?? '', origin ?? ''],
    queryFn: ({ signal }) =>
      unwrap(
        BlyggerApi.getForkOptions({
          client,
          query: { id, sub, origin },
          signal,
        }),
      ),
  });
}
