import { withoutComments } from '../comments.ts';
import { blygContactSeed, ContactOffer, type ContactSeed } from './contacts.tsx';
import { createSubscription, createHopper, removeHopperItem, createItem } from './server-mutations.ts';
import { previewFromHtml } from '../preview.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery, useLiveInfiniteQuery, eq, inArray } from '@tanstack/react-db';
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
  hopperInfo,
  hopperMemberships,
  hopperPreview,
  inbound,
  outbound,
  mentionGroupItemsView,
  mentionSummary,
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
/** `onSubscribed(told)`: told is true when the sheet has already said so, in its offer step. */
export function AddFeedForm({ onSubscribed, initialUrl = '' }: { onSubscribed?: (told: boolean) => void; initialUrl?: string }) {
  const action = useAction();
  const [url, setUrl] = useState(initialUrl);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    kind?: string;
    blygTitle?: string;
    siteMismatch?: {
      asserted: string;
      actual: string;
    };
  }>();
  const [offer, setOffer] = useState<{ title: string; seed: ContactSeed }>();
  const add = async (confirm = false, wholeBlyg = false) => {
    const result = await createSubscription({ url, confirm, ...(wholeBlyg ? { wholeBlyg: true } : {}) });
    if ('needsConfirm' in result) setConfirmation(result);
    else {
      setConfirmation(undefined);
      setUrl('');
      // The backfill runs on the server after this reply; polling brings its
      // items in, so the sheet need not wait on the refetch.
      // One blyg, subscribed by hand: bulk imports never come through this form.
      // The sheet stays open and becomes the offer, so nothing appears after it closes.
      const seed = result.kind === 'blyg' && !result.hopperFeedUrl ? await blygContactSeed(result).catch(() => null) : null;
      if (seed) setOffer({ title: result.title, seed });
      else onSubscribed?.(false);
    }
  };
  if (offer) {
    return (
      <div id="add-sub-offer">
        <p className="add-sub-done">Subscribed to {offer.title}.</p>
        <p><strong>Add this blyg to your address book?</strong></p>
        <ContactOffer seed={offer.seed} done={() => onSubscribed?.(true)} />
      </div>
    );
  }
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
          {confirmation.kind === 'hopper' ? (
            <p className="hint">
              One public collection on {confirmation.blygTitle ?? 'this blyg'}:
              its entries are excerpts and links, and leave when the curator
              removes them.
            </p>
          ) : null}
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
            {confirmation.kind === 'hopper' ? (
              <Button
                className="btn"
                disabled={action.busy}
                onClick={() => void action.run(() => add(true, true))}
              >
                subscribe to the whole blyg instead
              </Button>
            ) : null}
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
    await createHopper(name);
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
          {row.total > row.items.length ? (
            <p className="tiny muted hopper-more">+{row.total - row.items.length} more</p>
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
  const collection = useMemo(() => hopperInfo(id), [id]);
  const result = useLiveQuery({
    query: (q) => q.from({ hopper: collection }),
  });
  const row = result.data?.[0];
  const memberships = useLiveInfiniteQuery(q => q.from({ member: hopperMemberships }).where(({ member }) => eq(member.hopperId, id)).orderBy(({ member }) => member.rank, 'asc'), { pageSize: 25 });
  const ownIds = memberships.data.filter(member => member.subscriptionId === '~own').map(member => member.remoteId);
  const ownRows = useLiveQuery(q => q.from({ item: items }).where(({ item }) => inArray(item.id, ownIds))).data ?? [];
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
    await hoppers.update(id, row => { Object.assign(row, body); }).when('settled');
  };
  const remove = async () => {
    await hoppers.delete(id).when('settled');
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
      {memberships.data.map((member) => {
        const key = JSON.stringify([member.subscriptionId, member.remoteId]);
        const removeButton = (
          <Button
            className="btn btn-ghost btn-mini"
            onClick={() =>
              void action.run(async () => {
                await removeHopperItem({ id, sub: member.subscriptionId, remoteId: member.remoteId });
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
        const item = member.item;
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
                      const draft = await createItem({
                        mode: 'response',
                        source: {
                          subscriptionId: member.subscriptionId,
                          remoteId: member.remoteId,
                        },
                      });
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
      {memberships.hasNextPage ? <Button disabled={memberships.isFetchingNextPage} onClick={() => void memberships.fetchNextPage()}>load more members</Button> : null}
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
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const gone = mention.status === 'gone';
  useEffect(() => {
    if (!element.current) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      setVisible(entries.some(entry => entry.isIntersecting));
    }, { rootMargin: '100px' });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  const collection = useMemo(() => mentionSource(mention.id), [mention.id]);
  const sourceResult = useLiveQuery({ query: (q) => visible && !gone && mention.sourceId
    ? q.from({ source: collection }).findOne() : undefined });
  const source = sourceResult.data;
  let author = mention.sourceOrigin || mention.source;
  const name = mention.sourceAuthor?.name;
  if (typeof name === 'string' && name) author = name;
  return (
    <div
      ref={element}
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
                await inbound.update(mention.id, row => { row.hidden = !row.hidden; }).when('settled');
              })
            }
          >
            {mention.hidden ? 'show on page' : 'hide from page'}
          </Button>
          {mention.sourceId && !source ? (
            <span className="small muted">
              {visible && (sourceResult.isReady || sourceResult.isLoadingError || sourceResult.isSyncError)
                ? 'Source details unavailable.' : 'Checking source…'}
            </span>
          ) : mention.sourceId && source?.holder ? (
            <Button
              className="btn btn-ghost btn-mini"
              onClick={() =>
                void action.run(async () => {
                  const draft = await createItem({
                    mode: 'response',
                    source: {
                      subscriptionId: source.holder!,
                      remoteId: mention.sourceId!,
                    },
                  });
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
  const summary = useLiveQuery({ query: q => q.from({ summary: mentionSummary }).findOne() });
  const [direction, setDirection] = useState<'inbound' | 'outbound'>(
    'inbound',
  );
  return (
    <>
      <h2 className="view-h">mentions</h2>
      <p className="view-sub mentions-note">
        Verified responses from other blygs.
      </p>
      <MentionReadFailure result={summary} />
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
              {summary.data?.[value] ?? 0}
            </span>
          </Button>
        ))}
      </div>
      {direction === 'inbound'
        ? <InboundMentions defaultShowing={!!settings?.showResponsesDefault} />
        : <OutboundMentions hasSiteUrl={!!settings?.siteUrl} />}
    </>
  );
}

type MentionReadResult = {
  isLoadingError: boolean;
  isSyncError: boolean;
  isCrashed: boolean;
  collection?: { reload(): Promise<void> };
};
function MentionReadFailure({ result }: { result: MentionReadResult }) {
  if (!result.isLoadingError && !result.isSyncError && !result.isCrashed) return null;
  return <>
    <Failure error={new Error('Could not load mentions.')} />
    {!result.isCrashed && result.collection ? <Button className="btn btn-ghost btn-mini" onClick={() => void result.collection?.reload().catch(() => {})}>retry reads</Button> : null}
  </>;
}

function InboundMentions({ defaultShowing }: { defaultShowing: boolean }) {
  const groups = useLiveInfiniteQuery(mentionGroupItemsView, { pageSize: 10 });
  return <>
    <MentionReadFailure result={groups} />
    {groups.isLoading ? <p className="h-hint">Loading mentions…</p> : null}
    {groups.data.map(row => <MentionGroup key={row.group.targetItemId} row={row} defaultShowing={defaultShowing} />)}
    {!groups.isLoading && !groups.isLoadingError && !groups.isCrashed && !groups.data.length ? (
      <div className="empty">
        <span className="em" aria-hidden="true">↩</span>
        No verified mentions.
      </div>
    ) : null}
    {groups.hasNextPage ? <Button disabled={groups.isFetchingNextPage} onClick={() => void groups.fetchNextPage().catch(() => {})}>load more groups</Button> : null}
  </>;
}

function MentionGroup({ row: { group, item }, defaultShowing }: {
  row: (typeof mentionGroupItemsView.toArray)[number];
  defaultShowing: boolean;
}) {
  const id = group.targetItemId;
  const receipts = useLiveInfiniteQuery(q => q.from({ mention: inbound })
    .where(({ mention }) => eq(mention.targetItemId, id))
    .orderBy(({ mention }) => mention.orderKey, { direction: 'asc', stringSort: 'lexical' }), { pageSize: 10 });
  const mode = item?.responses ?? 'default';
  const showing = mode === 'show' || mode === 'default' && defaultShowing;
  const visible = showing ? group.visible : 0;
  return (
    <section className="card mention-group">
      <h3 className="card-h">
        {/* The public page shows the responses; editing is a side link. */}
        {item?.status === 'public' ? (
          <a href={publicPath(item)} target="_blank" rel="noreferrer">
            {withoutComments(item.contentMd).slice(0, 60) || id.slice(0, 8)} ↗
          </a>
        ) : (item && withoutComments(item.contentMd).slice(0, 60)) || id.slice(0, 8)}{' '}
        <Link className="muted small" to="/edit/$id" params={{ id }}>edit</Link>
      </h3>
      <p className="muted small group-meta">
        {group.total} responses · {visible} on the page now
      </p>
      <ResponseVisibility id={id} revision={item?.revision ?? 0} mode={mode} defaultShowing={defaultShowing} disabled={!item} />
      <MentionReadFailure result={receipts} />
      {receipts.isLoading ? <p className="h-hint">Loading mentions…</p> : null}
      {receipts.data.map(mention => <MentionRow key={mention.id} mention={mention} />)}
      {receipts.hasNextPage ? <Button className="btn btn-ghost btn-mini" disabled={receipts.isFetchingNextPage} onClick={() => void receipts.fetchNextPage().catch(() => {})}>load more mentions</Button> : null}
    </section>
  );
}

function OutboundMentions({ hasSiteUrl }: { hasSiteUrl: boolean }) {
  const outgoing = useLiveInfiniteQuery(q => q.from({ mention: outbound })
    .orderBy(({ mention }) => mention.orderKey, { direction: 'asc', stringSort: 'lexical' }), { pageSize: 25 });
  return (
    <>
      <MentionReadFailure result={outgoing} />
      {!hasSiteUrl ? (
        <div className="banner banner-warn mentions-note" role="note">
          <span className="mark" aria-hidden="true">!</span>
          <div className="body">
            No site URL is set. Set it in{' '}
            <Link to="/settings">settings</Link> before relying on outbound
            delivery.
          </div>
        </div>
      ) : null}
      {outgoing.isLoading ? <p className="h-hint">Loading mentions…</p> : null}
      {outgoing.data.length ? (
        <div className="card">
          {outgoing.data.map((mention) => (
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
                <a className="target" href={mention.target}>{mention.target}</a>{' '}
                · {mention.attempts} attempts
                {mention.nextAttemptAt && mention.status === 'pending'
                  ? ` · retrying after ${mention.nextAttemptAt}`
                  : ''}
              </div>
              {mention.lastError ? <div className="small err">{mention.lastError}</div> : null}
            </div>
          ))}
        </div>
      ) : null}
      {outgoing.hasNextPage ? <Button disabled={outgoing.isFetchingNextPage} onClick={() => void outgoing.fetchNextPage().catch(() => {})}>load more outbound mentions</Button> : null}
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
                    const draft = await createItem({
                      mode: 'fork',
                      source: {
                        origin: options.origin,
                        id,
                        version: version.version,
                      },
                    });
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
