# Deploying trigger revisions and feed caching

Apply migration `0024_change_state.sql` before deploying the new Worker. It
initializes a fixed revision row and 27 triggers over the existing content
tables. Relevant source writes and counter changes commit or roll back together.
Missing state and unsafe counter overflow reject writes rather than silently
lose notifications. No application mutation caller needs an invalidation hook.

### Mentions and responses domains (migration 0032)

`0032_mentions_change_domain.sql` adds two counters to `change_state` and six
triggers (insert, update, delete on `mentions_in` and `mentions_out`), so the
tracked set is now 36 `change_*` triggers over twelve tables (27 from 0024, three
from 0026 on `read_state`, six here):

| Domain | Moves when | Read by |
|---|---|---|
| `mentions` | any `mentions_out` change; a `mentions_in` change to a row whose status is, or was, `verified` or `gone` | Studio mentions view (both lists) and, with `reading`, each mention's source card |
| `responses` | a `mentions_in` change to a row that is, or was, `verified` and not hidden | public HTML: the responses list under an item (`listPublicResponses`) |

`responses` is in the public HTML cache key (`publicHtmlRevision`), so a newly
verified response, a hide or a show reaches the item page at once instead of
after the edge window (60 s plus up to 300 s stale-while-revalidate). A pending
claim, its failure and the daily prune of failed claims move neither counter:
anyone can POST a claim, and if claims rolled the key a stranger could empty
the edge cache at the receiver's rate cap. They still write the state row once,
like every tracked table, and are refused if it is missing.

Apply 0032 before deploying a Worker that reads these columns: `/api/changes`
selects every domain by name and fails without them, which stops Studio from
loading new data, and public pages fall back to the plain cache key (the
pre-0.46.1 60-second behaviour) until the migration lands. The first deploy
after 0032 changes every public cache key once, so each page renders fresh on
its next read.

Studio already polled the mentions view every 15 seconds, re-reading both lists
in full and every row's source card on each tick. Those reads are now gated on
the counters like every other owner read, so an unchanged tick costs one
`/api/changes` read per collection. Polls stop while the tab or installed PWA is
hidden. TanStack Query refreshes active queries when the page becomes visible
or the network reconnects (`src/ui/query-client.ts`). Live collections opt
into timers individually. Settings and authorizations have no polling timer.

The feed uses the existing `MEDIA` R2 binding. Objects under `__cache/feed/` are
internal XML artifacts, separate from attachment paths. Keys include software/
renderer version, request origin and mount. No new secret, bucket or Durable
Object is required. Renderer changes without a software version change must
bump the cache format in `src/feed-cache.ts`.

Configure three cron expressions in your deployment config (including an
existing ignored `wrangler.private.jsonc`):

```json
"triggers": { "crons": ["* * * * *", "*/15 * * * *", "0 0 * * *"] }
```

A config from before 0.32 lists only `*/15 * * * *`. That keeps working: the
quarter-hour tick polls as before and also runs the daily maintenance when it
falls at 00:00 UTC. Without the minute cron, feeds are refreshed only by reader
requests.

The minute job checks saved XML. Set **Settings → Canonical site URL** so it
knows which public origin to warm; `npm run init` already sets this for new
installations. With no valid HTTP(S) canonical URL, feed requests still rebuild
their own cache. Aliases also keep their request-driven checks.

An unchanged configured minute tick makes two small D1 reads (site URL and feed
revision) and one R2 lookup, with no XML render or R2 write: about 2,880 small
D1 lookups per day. These are extra checks, not deployed billing measurements.
The tick calls the existing feed handler in-process with HEAD, so no XML body
is returned. It shares normal SWR work: an active build can be joined, and the
next tick checks any source changes committed after that build sampled.

The 15-minute job still selects due subscriptions and retries outbound mentions.
Daily maintenance at midnight UTC repairs legacy imported URLs and prunes failed
inbound mentions past their 30-day retention. URL repairs retain the existing
200-row limit per run, so a large legacy backlog can take several days. Normal
new imports already resolve URLs. These scans no longer run every 15 minutes.

For a local manual tick, start Wrangler with `--test-scheduled` and run:

```sh
curl -G --data-urlencode 'cron=* * * * *' http://localhost:8888/__scheduled
```

Warm requests serve saved XML and ETag/304/HEAD responses immediately, then
check one D1 revision row. Unchanged checks do not rebuild or rewrite the file.
Changed checks use a stable render interval and conditional publication against
generation-bearing XML bytes. Cold creation blocks for an initial valid artifact. After three unstable render
attempts it checks for a valid same-key artifact saved by another builder; if
one exists, it serves that copy under the same SWR policy. A truly empty cache
still returns an error if no stable render interval can be found.
Interrupted work can retry on later cron ticks or feed requests. No maximum
stale age is guaranteed. XML can remain stale after withdrawal during this window.

Live Studio collections opt into TanStack Query's built-in 15-second polling.
Query Client defaults do not enable polling for other queries.
Hidden tabs pause polling; return and reconnect trigger a refresh.
Each query function makes a fresh change check, then returns its cached response
or fetches changed data. Several mounted queries can each read the revision row. Timed update-state and
unclassified/security views retain their existing polls. Authentication and
admission still execute on private requests. Counters add one state-row write
per changed source row, even when multiple domains advance. Measure read and
write totals separately; these changes do not establish a free-plan capacity.

## Database restores

Pause requests and disable cron triggers before restoring/replacing D1. Apply any missing migrations if
the backup predates `0024_change_state.sql`, and in particular `0032_mentions_change_domain.sql`:
the reset script below names the `mentions` and `responses` columns and fails on a
database without them. A restore brings back mention rows as they were at the backup,
so a response verified or hidden since then is undone on the public page too; the new
epoch makes every Studio and public cache entry re-read. Then run:

```sh
npx wrangler d1 execute DB --remote --file scripts/reset-change-epoch.sql
```

Pass your normal deployment configuration if it differs from `wrangler.jsonc`.
The script establishes a fresh epoch, resets counters, and can restore the
missing singleton. Resume requests and restore cron triggers only after this step. Do not run it during
ordinary upgrades: clients' cursors should survive code deployments. The
implementation work does not run this remote command or deploy production.

Clients reload on epoch change. The feed background check treats a different
epoch as a changed generation, and an old builder cannot replace a newer
installed generation using its old ETag. The first SWR response may still contain
saved pre-restore XML; this is not an immediate-removal or fail-closed public-feed
policy. Apply a separate stale-age/withdrawal policy if that contract is needed.

## Schema changes

Keep the migration's null-safe changed-column guards and table/column-to-domain
map current when adding response fields. Keep each collection's query-to-domain choice current
when adding revision-aware query functions. Unknown views keep polling. The receiving oracle
checks current column guards, direct effects, joined response dependencies,
failed/canceled Query responses, generation races and matching work observations.

## Review follow-ups

Revision checks are required for the current freshness contract. If `/changes`
fails, Studio keeps its cached data and the timer retries; it cannot fetch new
content until that check succeeds. A missing migration also blocks a cold feed.
A future Studio fallback could do a full read without a revision label, so a
later successful check cannot mistake it for validated cached data. Choosing
that fallback trades extra reads during outages for availability. A cold feed
fallback needs its own consistency policy: rendering without the stability
check can mix settings and item versions from different source states.

Feed triggers deliberately over-invalidate some unrelated imports,
subscriptions, drafts and media writes. Two possible improvements need design
review: narrower dependency-aware triggers, or a weak public ETag derived from
visible XML while preserving the generation-bearing R2 ETag for conditional
publication. Narrower triggers must still cover cited imported content and
joined dependencies. A separate public validator reduces downloads but does
not avoid rebuilds or cold-render churn. Do not remove the private generation
stamp to obtain this optimization; it protects against old builders replacing
new generations whose visible bytes happen to match.

The accepted request-driven SWR policy has no age bound. A maximum stale age or
withdrawal deadline would change that policy and can block requests during a
rebuild. Keep this decision separate from the concurrent-builder fallback.

HEAD and conditional requests currently obtain an R2 body stream even when the
HTTP response has no body. A metadata-only or conditional-get optimization is
still open. Measure transferred bytes before claiming whole-object downloads;
the current handler does not consume the stream for those responses. Preserve
weak/list/wildcard If-None-Match behavior when changing this path.

Query Collection observers poll the currently tracked Reading subsets. Released
views unload their subsets, so historical pages do not accumulate polling work.
Multiple active owners, including a view awaiting cleanup, can still cause more
than one page read on a revision change. Keep the receiving test for released
pages; preserve the shared-row ownership tests before changing refresh scope.
TanStack Query owns scheduling; there is no separate poll registry or key parser.

Software versions create new feed object keys. No cache-retention cleanup is
implemented. If storage becomes material, define a retention window that also
covers rollback and every origin/mount before deleting old objects.
