# Walkback

**Sources make claims. Walkback checks them against Sui mainnet, keeps every
claim and verdict in Walrus Memory, and demotes the sources that get it wrong —
so you literally see less of them tomorrow.**

> Walkback (n.) — the act of retracting a claim you made earlier.
> This app is what happens when nobody lets you forget you made it.

Built for the **Walrus x Tatum "Total Recall" Memory Hackathon** (Track 2:
Smart Agents for Real Life).

---

## Status

The UI, the Coolify API, and the worker are in place. Live writes still need
the owner's credentials on Coolify; nothing in this repo contains a key.

What works today:

- `npm run smoke` — proves the Walrus Memory mainnet delegate key works end to
  end (health → write → recall) and prints the delegate public key you need for
  the submission form.
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

`restore()` rebuilds the projection from Walrus. That path exists specifically
to prove the second row is the truth and the first is a cache.

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
| `price_threshold` | Tatum rate API *(unverified for SUI — see note)* |
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

`MEMWAL_AGENT_ID` for the submission form is the delegate **public** key;
`npm run smoke` prints it.

From the **Tatum dashboard**: `TATUM_API_KEY` and the Sui RPC gateway URL.

## Adding claims

`npm run seed` reads `data/claims.json` and runs each post through the same
ingest path as the app. Real posts are the dataset. The file in the repo is a
placeholder so the shape is obvious: every entry has `"synthetic": true`, the
handles start with `placeholder_`, and the text says so. Synthetic claims are
labelled in the feed, on the source page, and in the memory text, and the seed
summary counts them separately from real ones. The script warns when synthetic
posts are not a minority. Replace the placeholders before the demo.

A real post:

```json
{
  "id": "alice-2026-10-18-balance",
  "handle": "alice",
  "platform": "x",
  "published_at": "2026-10-18T15:04:00.000Z",
  "sui_address": "0x…",
  "text": "the post, verbatim",
  "snapshot": {
    "address": "0x…",
    "asset": "0x2::sui::SUI",
    "balance": "123000000000",
    "asOf": "2026-10-18T15:04:05.000Z"
  }
}
```

Leave `synthetic` off. `id` is a stable slug: re-running the seed finds it and
does not write the post again. Use a new handle for a real source. A
placeholder handle already has a source memory, and memory is append-only, so
that first synthetic memory is the one recall will keep finding. Omit `claims` and the model extracts them from
`text`. For a historical transfer, set `claims` yourself with
`"claim_type": "tx_replay"` and `since` / `until` in the params, so the window
is the one you mean. A `snapshot` recorded when you collected the post is the
receipt for `balance_change_since_ingest`. Sui cannot answer what the balance
was then, so a change claim without that receipt cannot be checked later.
`"snapshot": null` means there is no receipt and the seed will not call Tatum
to invent one. Omit `snapshot` to read the live balance at seed time.

Run the seed on Coolify, where `DATABASE_URL` and the provider keys exist. It
needs the Walrus delegate key, and — only for posts that omit `claims` or
`snapshot` — `AI_GATEWAY_API_KEY` and `TATUM_API_KEY`. The summary prints
memory counts per namespace, every blob id, and the score of each source.

```bash
npm run seed
```

## Deployment

Vercel runs the Next.js app: the pages, the read queries, and the routes that
insert a job row. Coolify runs one long-lived process, the worker, plus
Postgres. A Walrus write takes 6–24 seconds, so it never runs inside a request.
`POST /api/ingest`, `POST /api/rebuild`, `POST /api/resolve`, and
`POST /api/restore` insert into `ingest_jobs` and return `{ jobId }`. The
browser polls `GET /api/jobs/[id]`. The worker claims one row at a time with
`FOR UPDATE SKIP LOCKED` and calls the existing library code, which already
goes through `memwalWriteLimiter`.

| Service | Where | Build / start | Port |
|---|---|---|---|
| Frontend and read routes | Vercel | `npm run build`, then Vercel’s start | Vercel |
| Worker | Coolify | Dockerfile `Dockerfile.worker` | none |
| Postgres | Coolify | internal service | 5432 on the private network |

Worker image:

```bash
docker build -f Dockerfile.worker -t walkback-worker .
docker run --env-file /path/to/worker.env walkback-worker
```

The image command is `node --conditions=react-server --import tsx worker/index.ts`.
Locally that is `npm run worker`. `--conditions=react-server` is required
because the database client imports `server-only`. The worker applies
`drizzle/` on boot. `npm run db:migrate` is the same migrator for a one-off
on Coolify. There is no HTTP port and no health check.

Postgres stays on the Coolify network. The worker should use the internal
hostname. The Vercel routes also open `DATABASE_URL` for reads and for
inserting jobs, so the URL configured on Vercel has to be one Vercel can
actually connect to. `MEMWAL_PRIVATE_KEY` is set on the worker only.

### Env vars on Vercel

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Postgres URL reachable from Vercel. Reads and job insert. |

Leave `MEMWAL_PRIVATE_KEY`, `MEMWAL_ACCOUNT_ID`, `TATUM_API_KEY`, and
`AI_GATEWAY_API_KEY` unset on Vercel.

### Env vars on the Coolify worker

| Variable | Notes |
|---|---|
| `DATABASE_URL` | `postgres://…@<coolify-postgres-host>:5432/walkback` |
| `MEMWAL_ACCOUNT_ID` | `0x` + 64 hex |
| `MEMWAL_PRIVATE_KEY` | Delegate private key. Worker only. |
| `MEMWAL_SERVER_URL` | `https://relayer.memory.walrus.xyz` |
| `TATUM_API_KEY` | From the Tatum dashboard |
| `TATUM_SUI_RPC_URL` | `https://sui-mainnet.gateway.tatum.io` |
| `TATUM_RATE_URL` | `https://api.tatum.io/v4/data/rate/symbol` |
| `AI_GATEWAY_API_KEY` | Claim extraction |
| `DEMO_MODE` | `live` |
| `WORKER_POLL_MS` | Optional. Default `2000`. |
| `WORKER_RESOLVE_MS` | Optional. Default `60000`. Set `0` to skip the periodic resolve pass. |

Seed is a one-off with the worker’s environment: `npm run seed`.

## Known open questions

- `price_threshold` depends on the Tatum rate endpoint supporting `symbol=SUI`.
  The endpoint requires auth, so this is unverified until a key exists. If Sui
  is unsupported, the claim type gets disabled in config rather than shipped
  broken.
- `restore()` has no pagination cursor and costs seconds per blob; large
  namespaces may not fully restore in one call.

## License

MIT
