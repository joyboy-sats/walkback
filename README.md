# Walkback

**Sources make claims. Walkback checks them against Sui mainnet, keeps every
claim and verdict in Walrus Memory, and demotes the sources that get it wrong —
so you literally see less of them tomorrow.**

> Walkback (n.) — the act of retracting a claim you made earlier.
> This app is what happens when nobody lets you forget you made it.

Built for the **Walrus x Tatum "Total Recall" Memory Hackathon** (Track 2:
Smart Agents for Real Life).

## Disclaimer

Walkback audits public claims against onchain data. A low score means the claims we could check did not hold — not that the person is dishonest. Scores cover only the claims in this ledger, not the whole account.

## Methodology

Walkback scores only claims it can check. The closed set is `balance_threshold` (current balance via `suix_getBalance`), `balance_change_since_ingest` (the snapshot taken at ingest, compared with the balance at the deadline), `tx_replay` (`suix_queryTransactionBlocks` with `showBalanceChanges`), `price_threshold` (Tatum historical USD candles over the claim's window), and `manual` (a human verdict, used as a demo fallback). Anything outside that set is rejected before it is stored.

A verdict is `true` or `false` when that check decides the claim. `void` means the claim could not be verified: the deadline has not passed, there was no snapshot, the address is a placeholder, the candle series does not cover the pair or the window, a boundary candle cannot place the extreme inside the window, the replay window was truncated or a transfer could not be read, or the check failed. A void is not a lie. It does not count as a hit or a miss, and it does not move the score. A claim that was checkable and missed its target is `false`. It stays in the ledger. The outcome is not a reason to drop or rewrite it.

A price touch is the high or low inside `[published_at, deadline)`, compared as the candle's unrounded decimal. A candle whose whole bucket sits inside that window can establish the touch. A candle that overlaps the window but starts before publish or ends after the deadline can only bound the overlap: its high or low may have printed outside. When the verdict depends on that partial bucket, or the edge is missing, that slice is re-read at a finer interval — one-minute candles for an hour, hourly candles for a day. If the finer series still cannot place the extreme inside the window, or does not cover the slice, the claim is `void`. The evidence records the deciding candle or candles, whether each one established the touch or only bounded it, and the window high and low.

When the post names a horizon, that horizon is the deadline, in UTC, and `deadline_basis` says the post stated it. Weeks run Monday through Sunday. "This week" ends that Sunday at 23:59:59.000Z. "Next week" ends the following Sunday. "This week or next week" ends the Sunday after next. "This month" and "by the end of {Month}" end on that month's last day at 23:59:59.000Z. A trade setup that states no date uses a benchmark of exactly 7 days after `published_at`. A technical-analysis post that states no date uses a benchmark of exactly 14 days. Every post in a class uses the same `deadline_basis` phrase, and the phrase says it is a benchmark convention. The six price claims collected on 2026-10-20 keep the deadlines chosen then (2026-10-30 and 2026-11-08). They were not moved onto the 7-day or 14-day benchmark.

The number is the lower bound of a 95% Wilson score interval over hits and misses. It is not a raw hit rate and not a model call. One correct guess is not evidence: 1 hit out of 1 claim is about 0.21, and 8 out of 10 is about 0.49.

The mute threshold is 0.40 and the trust threshold is 0.55. Once at least 3 claims have been adjudicated, a bound below 0.40 mutes the source and its claims leave the feed. A bound of 0.55 or higher is trusted. Below 3 adjudicated claims the source is unrated: the UI shows an em dash instead of a number, plus how many verdicts are still needed, and the source is not muted — even when the stored bound is 0.

---

## Status

The UI, the Coolify API, and the worker are in place. Live writes still need
the owner's credentials on Coolify; nothing in this repo contains a key.

What works today:

- `npm run smoke` — proves the Walrus Memory mainnet delegate key works end to
  end (health → write → recall) and prints the delegate public key
  (`getPublicKeyHex()`, the submission form's `MEMWAL_AGENT_ID`).
- `npm run list:memories` — with `.env.local` on a machine that has the
  delegate key, pages the relayer inventory and prints counts only. It reads
  `MEMWAL_ACCOUNT_ID`, `MEMWAL_PRIVATE_KEY`, and `MEMWAL_SERVER_URL` only.
- `npm run test`, `npm run typecheck`, `npm run build`.

## Why the design looks like this

Two platform constraints shaped the product, and rather than working around
them we made them the pitch.

**Historical balances are not queryable.** Tatum's Sui surface gives you
`suix_getBalance`, `suix_getAllBalances`, `suix_queryTransactionBlocks`,
`suix_queryEvents` and `sui_tryGetPastObject` — but no balance history. So
Walkback freezes the world at the moment a claim is made: ingest takes a
balance snapshot alongside the quote and stores both. At deadline it compares.
A claim that arrives without a snapshot is `void`, because *a claim without a
receipt is not a claim*. Older claims are rebuilt by replaying transactions
with `showBalanceChanges`.

**Memory is append-only and similarity-ranked.** Walrus Memory has no
structured query, no upsert, and namespaces are exact-match flat strings. So
the system has two layers with different jobs:

| Layer | Holds | Role |
|---|---|---|
| Postgres on Coolify (private) | queryable projection: sources, claims, resolutions, score versions, jobs | fast reads for the UI |
| Walrus Memory (mainnet) | every claim, verdict and score version, as narrative text | **system of record** |

`restore()` and the Memory page read Walrus back. Verify pages
`GET /v1/owners/:owner/memories` (metadata) and loads plaintext with `recall()`,
matched to those blob ids. It leaves the tables in place. Replacing the
projection happens only after that list coverage is complete. If the list route
is missing, the report is a marked recall sample and Replace stays off. Walrus
stays the system of record; Postgres is the cache.

## Adjudication contract

A claim is admissible only if it has an explicit deadline within 30 days and
its truth is decidable by reading chain state or a market price. Anything
vaguer is rejected before it is ever stored. The closed set of checkable
types:

| `claim_type` | Checked with |
|---|---|
| `balance_threshold` | `suix_getBalance` |
| `balance_change_since_ingest` | snapshot vs. `suix_getBalance` at deadline |
| `tx_replay` | `suix_queryTransactionBlocks` + `showBalanceChanges` |
| `price_threshold` | Tatum historical USD candles (`/v4/data/rate/symbol/OHLCV`) |
| `manual` | human verdict, demo fallback |

Trust is a **Wilson lower bound** over hits and misses, not a raw ratio and not
an LLM's opinion. `1/1` scores ~0.21 and `8/10` scores ~0.49: one lucky guess
earns nothing. Every score change is its own memory entry, referencing the
verdict that caused it — that is the audit trail behind "why did this source
get muted?"

## Setup

Requires Node ≥ 20.

```bash
npm install
cp .env.example .env.local     # then fill in the credentials
npm run smoke
```

`.env.local` is gitignored. The delegate key is server-only in the app and must
never be prefixed `NEXT_PUBLIC_` — this repository is public.

### Credentials

From **memory.walrus.xyz** → SDK credentials:

- `MEMWAL_ACCOUNT_ID` — account object ID
- `MEMWAL_PRIVATE_KEY` — Ed25519 delegate private key
- `MEMWAL_SERVER_URL` — `https://relayer.memory.walrus.xyz` (mainnet)

`MEMWAL_AGENT_ID` for the submission form is the delegate public key from
`getPublicKeyHex()`. It is a public config value, not a secret. `npm run smoke`
prints it. `npm run list:memories` (same `.env.local`) prints how many memories
the relayer lists, and nothing else.

From the **Tatum dashboard**: `TATUM_API_KEY` and the Sui RPC gateway URL.

## Adding claims

`npm run seed` reads `data/claims.json` and runs each post through the same
ingest path as the app. The file in the repo is the real set: 30 posts, 33
claims, 10 handles. Eleven are `tx_replay` posts from `@_OnChainWatch`.
Twenty-two are `price_threshold` claims, all `evaluation: touch` against
`USD`. Six of those, all `SUI`, were collected on 2026-10-20 and stay pending
until 2026-10-30 or 2026-11-08. Sixteen are historical and already past their
deadline: four from `@Community_Sui`, three from `@mrcamerontrader`, three
from `@cryptowithgopal` (including both borderline calls), four from one
`@Sophia_WebX` post (`SUI`, `SOL`, `ETH`, `BTC`), and two from `@suintern_`.
The candidate file had no third admissible `@suintern_` claim, so that source
stays under three verdicts. Backup accounts were not added. None of the posts
are marked synthetic. `@mysqlsui` and both `balance_threshold` claims were
left out on purpose. Four historical claims the collector scored below 0.6
are stored at the 0.6 floor; the targets and windows are the ones in the
posts.

Each post has `source_url`, the permalink of the original X post. The feed
and the source page link there when the URL is `https`.

A post with `"synthetic": true` is a demo fallback. The seed summary counts
those separately and warns when they are not a minority. Keep any fixture
like that out of `data/claims.json`, or label it.

Shape of a post:

```json
{
  "id": "alice-2026-10-18-balance",
  "handle": "alice",
  "platform": "x",
  "published_at": "2026-10-18T15:04:00.000Z",
  "source_url": "https://x.com/alice/status/1",
  "sui_address": "0x…",
  "text": "the post, verbatim",
  "snapshot": null
}
```

Leave `synthetic` off. `id` is a lowercase slug (letters, digits, hyphens):
re-running the seed finds it and does not write the post again. Omit `claims`
and the model extracts them from `text`. The committed file sets `claims` on
every post, so the seed does not call the model. For a historical transfer,
`"claim_type": "tx_replay"` carries `since` / `until` in the params. A
`snapshot` recorded when you collected the post is the receipt for
`balance_change_since_ingest`. Sui cannot answer what the balance was then.
`"snapshot": null` means there is no receipt and the seed will not call Tatum
for a live balance. Omit `snapshot` to read the live balance at seed time.
The replay posts in the file use `null`, because a live balance is not the
receipt for a past transfer.

Postgres is on Coolify's internal network. A laptop cannot open `DATABASE_URL`.
Run the seed in the Coolify **worker** container's terminal, after this image
is deployed. The worker and the API apply `drizzle/` on boot, including
`claims.source_url`. `npm run seed` does not migrate. The container already
has `DATABASE_URL`, `MEMWAL_PRIVATE_KEY`, and `TATUM_API_KEY`.

```bash
npm run seed
npm run list:memories
```

`TATUM_API_KEY` is required: the eleven replay deadlines and the sixteen
historical price deadlines are already past, so the seed resolves them. A
post whose applied marker is set is skipped, and a claim that already has a
resolution is not checked again. Before resolve, the log estimates the OHLCV
cost of every still-unresolved past-deadline price claim. For this file that
is 124 hourly batch calls, 62,000 credits, if all sixteen are still pending.
One-minute reads of a boundary hour are extra, and only when that partial
candle could decide the touch, at most 32,000 credits. After resolve the log
prints the credits this run actually spent. A second run of an
already-resolved file spends none. `AI_GATEWAY_API_KEY` is not required,
because every post already has `claims`. The summary prints memory counts per
namespace, every blob id, and the score of each source. `list:memories`
prints the whole delegate account, not only this run. The worker image
includes `scripts/`, `data/claims.json`, and `tsx`, which those two commands
need.

### Re-resolve a void

A void is sticky: the first resolution is kept, and a later pass does not
check the claim again. When a void was a failed check rather than an honest
"could not tell", append a new resolution from the worker container. The
previous memory stays. The new one uses `resolution:{claimId}:r2` (then
`r3`, …). A void that becomes true or false writes the next score version.
The Wilson replay keeps the latest outcome per claim, so the new hit is
counted once. A claim that is already true or false is skipped unless you
pass `--force`.

```bash
npm run reresolve -- \
  --source-url https://x.com/_OnChainWatch/status/2112452984638444019 \
  --source-url https://x.com/_OnChainWatch/status/2112436525434622020
```

The same body works over the API, which checks `x-admin-token` and enqueues
the job for the worker:

```bash
curl -s -X POST "$API/resolve" \
  -H "content-type: application/json" \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -d '{"supersede":true,"sourceUrls":["https://x.com/_OnChainWatch/status/2112452984638444019","https://x.com/_OnChainWatch/status/2112436525434622020"]}'
```

## Deployment

Postgres runs on the Coolify internal network. Vercel cannot open it, so the
Vercel app is only the Next.js UI. Every read and every enqueue goes over HTTP
to a small API on Coolify. That API is `server/index.ts` (Node’s `http`
module, no second framework and no second copy of Next.js). It reuses `lib/`
for queries and for inserting `ingest_jobs`. The worker claims those rows and
does the Walrus writes, which take 6–24 seconds and never run inside a request.

`npm run check:vercel` (also part of `npm test`) fails if anything under `app/`
reaches `lib/db` or `lib/env`, or reads a `process.env` name that is not
`NEXT_PUBLIC_*`.

One image, two Coolify services. The root `Dockerfile` starts the API. `Dockerfile.worker` is the same build with the worker command. You can also build the root file once and override the start command on the worker service.

| Service | Where | Build / start | Port |
|---|---|---|---|
| Frontend | Vercel | `npm run build` | Vercel |
| API | Coolify | `Dockerfile` | **8080**, `GET /health` |
| Worker | Coolify | `Dockerfile.worker`, or the API image with the worker command | none |
| Postgres | Coolify | internal service | 5432, not public |

```bash
docker build -f Dockerfile -t walkback .
docker run -p 8080:8080 --env-file backend.env walkback

docker build -f Dockerfile.worker -t walkback-worker .
docker run --env-file worker.env walkback-worker
```

The API image includes `curl`. Point Coolify’s healthcheck at `GET http://localhost:8080/health`. The worker has no HTTP port, so disable the healthcheck on that Coolify service.

API command, also `npm run api`:

`node --conditions=react-server --import tsx server/index.ts`

Worker command, also `npm run worker`:

`node --conditions=react-server --import tsx worker/index.ts`

`--conditions=react-server` is required because the database client imports
`server-only`. Both processes apply `drizzle/` on boot. `npm run db:migrate`
is the same migrator for a one-off.

Reads (`GET /feed`, `/sources/:id`, `/memory`, `/jobs/:id`) are public.
Writes (`POST /ingest`, `/rebuild`, `/resolve`, `/restore`) require the header
`x-admin-token: <ADMIN_TOKEN>`. CORS reflects `CORS_ORIGIN` only.

The ingest page and the Memory page ask for that token once per browser tab
and keep it in `sessionStorage`. Vercel does not have a copy. Closing the tab
drops it. A rejected token is cleared so the next submit asks again. On
Memory, verify is the button you press in a demo. It pages the relayer
inventory. Replace projection is enabled only after that list coverage is
complete. Run `npm run list:memories` on the worker host once, with the real
delegate key, and confirm the live route returns a count before using Replace.

### Env vars on Vercel

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_API_URL` | Public origin of the Coolify API, no path, no trailing slash. Set before `next build`. Not a credential. |

That is the only variable. No `DATABASE_URL`, no `ADMIN_TOKEN`, no provider keys.

### Env vars on the Coolify API

| Variable | Notes |
|---|---|
| `PORT` | `8080` |
| `DATABASE_URL` | `postgres://…@<coolify-postgres-host>:5432/walkback` |
| `ADMIN_TOKEN` | Shared secret, at least 16 characters. The owner types this into the browser. |
| `CORS_ORIGIN` | The Vercel origin, for example `https://walkback.vercel.app`. Comma-separated if you have more than one. |

The API does not need the Walrus or Tatum keys.

### Env vars on the Coolify worker

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Same database, internal hostname |
| `MEMWAL_ACCOUNT_ID` | `0x` + 64 hex |
| `MEMWAL_PRIVATE_KEY` | Delegate private key |
| `MEMWAL_SERVER_URL` | `https://relayer.memory.walrus.xyz` |
| `TATUM_API_KEY` | From the Tatum dashboard |
| `TATUM_SUI_RPC_URL` | `https://sui-mainnet.gateway.tatum.io` |
| `TATUM_RATE_URL` | `https://api.tatum.io/v4/data/rate/symbol` (spot; not used for verdicts) |
| `TATUM_OHLCV_URL` | `https://api.tatum.io/v4/data/rate/symbol/OHLCV` |
| `TATUM_OHLCV_BATCH_URL` | `https://api.tatum.io/v4/data/rate/symbol/OHLCV/batch` |
| `AI_GATEWAY_API_KEY` | Claim extraction |
| `EXTRACT_MODEL` | Optional. Gateway model id, not a secret. Default `deepseek/deepseek-v4.1-flash` (DeepSeek V4.1 Flash). The API and Vercel do not read it. |
| `DEMO_MODE` | `live` |
| `WORKER_POLL_MS` | Optional. Default `2000`. |
| `WORKER_RESOLVE_MS` | Optional. Default `60000`. Set `0` to skip the periodic resolve pass. The pass enqueues only when a claim is pending and past its deadline, and it waits longer after a claim's resolve keeps throwing. |

Seed is a one-off in the worker container's terminal, after the image is deployed: `npm run seed`, then `npm run list:memories`. The worker image includes `scripts/`, `data/claims.json`, and `tsx`.

## Known open questions

- `price_threshold` is judged from Tatum historical USD candles
  (`/v4/data/rate/symbol/OHLCV`), not from the spot rate at the moment the
  worker runs. The window rule, the unrounded comparison, and the deadline
  convention are in Methodology. A missing symbol, a non-USD quote, a gap, or
  a boundary candle that cannot place the extreme inside the window is `void`
  and does not move the score. A checkable miss is `false`. Sixteen historical
  touches are already due. The six collected on 2026-10-20 stay pending until
  2026-10-30 and 2026-11-08. `deadline_basis` records why that deadline was
  chosen.
- `restore()` has no pagination cursor and costs seconds per blob; large
  namespaces may not fully restore in one call.

## License

MIT
