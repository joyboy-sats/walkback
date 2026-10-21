# Walkback — working notes for coding agents

Read this before touching anything. Most of it is not style preference: it
records constraints discovered by reading the SDK's `.d.ts`, reading Tatum's
docs, and measuring the live mainnet relayer. Violating them produces code that
appears to work and then fails at submission time.

## What this is

A web app where you register **sources**, extract **falsifiable claims** from
what they say, adjudicate those claims against **Sui mainnet via Tatum**, write
every claim / verdict / score version to **Walrus Memory on mainnet**, and let
the resulting trust scores visibly change what the product shows you.

Hackathon: Walrus x Tatum "Total Recall". Deadline 2026-11-10 17:00 UTC
(= 2026-11-11 01:00 SGT). Submission needs: mainnet memories (≥10, we target
30+), Tatum RPC used for the onchain data, public repo, blog post, demo video.

## Hard constraints

**Walrus Memory**

- Package `@mysten-incubation/memwal` is pinned to **0.1.8** (exact, no `^`).
  Peer deps that must be installed: `@mysten/sui`, `@mysten/seal`,
  `@mysten/walrus`, `ai`, `zod`. Node ≥ 20.
- Mainnet relayer is `https://relayer.memory.walrus.xyz`. Staging is
  `relayer-staging.memory.walrus.xyz` — it must never appear in this repo.
- `MemWal.create({ key, accountId, serverUrl, namespace?, requestTimeoutMs? })`.
  The field is `serverUrl`, not `relayerUrl`.
- `remember()` returns `{ job_id, status }` and **no blob_id**. Only
  `rememberAndWait()` / `rememberBulkAndWait()` return `blob_id`. Anything that
  persists a claim needs a blob_id, therefore needs the waiting call.
- A single write costs **~22–27s** of server time; a bulk of 5 costs 30.7s
  (**6.1s/item**). Measured on mainnet — see `scripts/timing.ts`. Consequence:
  **never write memories synchronously inside a request a user is waiting on.**
  Use bulk, or a background job, or a pre-seeded demo dataset.
- Delegate keys are limited to **30 points/minute** per key. All writes go
  through `memwalWriteLimiter` in `lib/ratelimit.ts` (set to 25/min).
- `remember` is **append-only**. No upsert, no update, no delete. `forget()` and
  `clear()` exist only on `MemWalMock`, not the real class. Do not build a
  delete UI. Logical deletion = append a tombstone memory + filter in the
  projection (`lib/memory-text.ts → tombstoneMemory`).
- Deduplication is `idempotencyKey`. The SDK keeps a key while a request has no
  acknowledged response, so retrying with the same key collapses onto the
  original paid job. Derive keys from domain identity (`claim:{id}`,
  `resolution:{id}`, `score:{sourceId}:v{n}`) and allow retries.
- Namespaces are **exact-match flat strings**. `walkback.claim` and
  `walkback.claim.v2` are unrelated. No prefix search, no hierarchy. All
  namespaces live in `NS` in `lib/types.ts`.
- `recall()` is similarity search, not a query language. It cannot filter by
  field or sort by column. Hits must be re-parsed, never treated as rows.
- `restore(namespace, limit)` has **no pagination cursor**, costs seconds per
  blob, and may return `truncated: true`. Call off the request path.
- `getPublicKeyHex()` returns a **Promise**, not a string.

**Tatum**

- JSON-RPC endpoint `https://sui-mainnet.gateway.tatum.io`, auth via the
  `x-api-key` header. Copy the URL from the dashboard; do not construct it.
- Free tier: 100k credits, **3 req/s**, 2 credits per ordinary RPC call.
  All calls go through the limiter in `lib/tatum.ts`.
- Sui has **no historical balance query**. `suix_getBalance` is current-state
  only. This is the single most important constraint in the product: it is why
  `balance_change_since_ingest` exists and why ingest stores a `snapshot`.
  Anything about the past must use `suix_queryTransactionBlocks` with
  `showBalanceChanges`.
- Spot `getRate` (`/v4/data/rate/symbol`, 20 credits, `symbol` + `basePair`)
  is not used for verdicts. Price claims use historical USD candles:
  `GET /v4/data/rate/symbol/OHLCV` (one candle, 50 credits) and
  `GET /v4/data/rate/symbol/OHLCV/batch` (up to 50 candles, 500 credits).
  Hourly first, daily if hourly cannot be requested. A 404 or a candle that
  does not cover the window resolves `void`. There is no CoinGecko client.
  The nearest-candle behavior of the single endpoint is not a price: if the
  returned bucket does not contain the requested time, the verdict is void.

## Architecture

```
app/                    Next.js App Router — the UI. Vercel hosts only this.
  page.tsx              Feed: claims ranked by source trust
  sources/[id]/         Score timeline + evidence chain
  memory/               Raw memory log + restore button
  ingest/               Paste a post. Enqueues a job. Does not write Walrus.

server/index.ts         Coolify API. Reads and job enqueue.
worker/index.ts         Claims jobs, adjudicates, writes Walrus memories.

lib/
  env.ts                validated env, client-bundle guard
  types.ts              domain types + NS constants
  score.ts              Wilson lower bound, thresholds. PURE.
  ratelimit.ts          token bucket. PURE.
  tatum.ts              RPC client: limiter, retries, replay fixtures
  memwal.ts             THE ONLY module allowed to import the memwal SDK
  memory-text.ts        memory text builders. PURE.
  adjudicate.ts         claim -> verdict. Never throws; failures become void.
  extract.ts            LLM claim extraction (the only model call)
  resolve.ts            the learning loop: adjudicate -> score -> write -> project
  db/                   Drizzle schema + client

scripts/
  smoke.ts              verifies mainnet credentials end to end
  timing.ts             measures write latency
  seed.ts               backfill from data/claims.json (real posts)
  list-memories.ts      count live memories on the delegate
```

Postgres is the Coolify internal database. Migrations in `drizzle/` apply on
API and worker boot, and via `npm run db:migrate`. Vercel receives only
`NEXT_PUBLIC_API_URL`.

### Two layers, different jobs

| Layer | Holds | Role |
|---|---|---|
| Postgres | sources, claims, resolutions, score_versions, memory_log | queryable projection, for the UI |
| Walrus Memory | every claim / verdict / score version as narrative text | **system of record** |

Walrus wins if they disagree; `restore` rebuilds the projection from it. Never
assume the memory layer can answer a structured question — that is what the
projection is for. Never treat the projection as durable truth.

## Rules of engagement

- Before writing any memwal or Tatum call, read the installed package's
  `.d.ts`. Do not guess signatures.
- Every external call has a timeout and a cached/replay fallback.
  `DEMO_MODE=replay` must run the whole demo with the network down.
- `void` is not `false`. A claim we could not check says nothing about the
  source's honesty and must never move a score. UI copy must say "could not
  check", never "lied".
- Trust is a formula, not a model call. If a number cannot be recomputed from
  stored verdicts, it does not belong in the product.
- Prefer deleting a feature to adding a config flag.
- No auth, no wallet connect, no payments, no multi-tenancy, no mobile, no
  realtime push.

## Secrets

The delegate key is server-only. `lib/env.ts` throws if imported into client
code, and `lib/memwal.ts` imports `server-only`. Never use a `NEXT_PUBLIC_`
name for anything in `.env.example`. The repo is **public**.

## Commands

```bash
npm run smoke       # verify mainnet credentials, prints delegate public key
npm run typecheck   # tsc --noEmit — must stay clean
npm run test        # vitest
npm run db:push     # drizzle-kit push
npm run seed        # backfill historical claims
```
