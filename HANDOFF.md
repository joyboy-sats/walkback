# Handoff — what is done, what is left

Read `CLAUDE.md` first. It lists the constraints that were discovered by reading
the SDK `.d.ts`, reading Tatum's docs, and measuring the live relayer. They are
not style preferences; most of the bugs an agent will write here come from
ignoring them.

Current state: the library and the app shell are complete and building. What
remains is mostly surface area, seed data, and the submission artefacts.

**Done and verified**

- Mainnet credentials work end to end (`npm run smoke`): health → write →
  recall, real `blob_id` returned.
- Write latency measured: ~24s single, 6.1s/item bulk (`npm run timing`).
- `lib/`: env, types, score (+15 tests), ratelimit, tatum, memwal, memory-text,
  adjudicate, extract, ingest, resolve, memory-log, db.
- `app/`: Feed, Source detail, Memory Explorer, Ingest. The UI talks to the
  Coolify API (`server/index.ts`). The worker (`worker/index.ts`) adjudicates
  and writes Walrus. Vercel does not run those routes.
- `npm run typecheck`, `npm run test`, `npm run build` all pass.

**Blocks that need a human, not an agent**

- `price_threshold` is judged from Tatum historical USD candles
  (`/v4/data/rate/symbol/OHLCV` and the batch route), not the spot rate.
  A touch starts with daily candles. A partial boundary candle cannot by
  itself establish a touch; that day is re-read hourly, then a boundary hour
  at one minute, and an extreme that still cannot be placed inside the window
  is `void`. An unsupported symbol or a gap is also `void`. A checkable miss
  is `false`. Sixteen historical touches are already due. Six earlier ones
  stay pending until 2026-10-30 and 2026-11-08.
- `AI_GATEWAY_API_KEY` is unset, so extraction has never run.
- `DATABASE_URL` is unset, so the projection has never been created.
- `MEMWAL_AGENT_ID` is assumed to be the delegate public key. Unconfirmed.

---

## Task 1 — Database bootstrap

Done. Postgres is the Coolify internal database, not Neon. Schema changes live
in `drizzle/` and apply on API and worker boot, and with `npm run db:migrate`.
`npm run seed` does not apply them. `claims.source_url` is `drizzle/0002_source_url.sql`.

**Acceptance:** `\dt` in psql shows `sources`, `claims`, `resolutions`,
`score_versions`, `memory_log`, `seed_posts`, and the enums. `claims` has
`source_url`.

---

## Task 2 — Ingest screen

`app/api/ingest` works; there is no UI. Build `app/ingest/page.tsx`.

Fields: handle, platform, published-at, optional SUI address, and a textarea for
the post. POST to `/api/ingest`, then show the result **honestly**:

- extracted claims with their type, deadline and confidence
- claims that were rejected, with the reason `ingest` returned
- the snapshot that was taken, if any, including the balance
- the blob ids written

**Acceptance:** pasting a real post produces rows, blob ids render, and a post
with no checkable claim shows "0 claims extracted" rather than an error. That
last case is the common one and must not look broken.

**Note:** this call takes ~1s + 6s per memory. Show a progress state; do not
let it look frozen.

---

## Task 3 — Restore that actually rebuilds

`/api/restore` currently only calls `restoreNamespace`, which rebuilds the
**relayer's vector index**. That is not the demo. The demo is: drop the
Postgres projection, replay from Walrus, get the scores back.

Write `lib/projection-rebuild.ts`:

1. For each namespace in `NS`, and for each, page through memories with
   `recallMemory` using a stable query and a large `limit`.
2. Parse the fenced JSON block from each memory's text (`lib/memory-text.ts`
   writes it; read it back).
3. Reconstruct `sources`, `claims`, `resolutions`, `score_versions` rows.

Then wire a button on `/memory` that truncates the projection, runs the rebuild,
and reports how many rows came back.

**Acceptance:** `TRUNCATE` all five tables, click rebuild, and the Feed shows
the same sources with the same scores. This is the strongest single shot for
the Best Walrus Memory prize — it must work without hand-holding.

**Careful:** `recall` is similarity search, not `SELECT *`. Two consequences:
you need queries that surface *everything* (loop over namespaces with several
distinct queries, or dedupe by `blob_id` across results), and you must not
assume order. Dedupe on `blob_id`.

---

## Task 4 — Seed data

`scripts/seed.ts` reads `data/claims.json`. The committed file is real X posts.
None are synthetic. The first 17 posts (17 claims, 7 handles) were collected
2026-10-20 (SGT). Thirteen later posts add the primary historical price set
from `@Community_Sui` (4), `@mrcamerontrader` (3), `@cryptowithgopal` (3),
`@Sophia_WebX` (4 claims in one post: SUI, SOL, ETH, BTC), and `@suintern_`
(2). That is 30 posts, 33 claims, 10 handles. Backup accounts were not added.
The candidate file had no third admissible `@suintern_` claim.

- 11 `tx_replay` claims from `@_OnChainWatch`. Deadlines are on or before
  2026-10-20, so a seed run resolves them. Each post sets `"snapshot": null`
  so ingest does not read a live balance. The post whose quote says
  `From: 0x1ae70480` while the stored address differed is omitted; it had no
  other claim.
- 6 `price_threshold` claims from the 2026-10-20 set, every one `SUI`/`USD`
  and `evaluation: touch`. Deadlines stay 2026-10-30 and 2026-11-08, so the
  seed leaves them pending. Those deadlines were not rewritten.
- 16 historical `price_threshold` claims, all `evaluation: touch` and `USD`.
  Their deadlines are already past, so one production seed adjudicates them.
  A deadline the post states is labelled `stated`. A trade setup with no date
  uses the 7-day benchmark; a technical-analysis post with no date uses the
  14-day benchmark. The same phrase is used for every post in that class.
  See README Methodology. A miss stays `false`. Missing coverage is `void`.
  The log's expected Tatum cost for these 16, if they are still unresolved,
  is 16 daily batch calls (8,000 credits). Worst case, refining every
  boundary day and hour, is 49,000. `SEED_OHLCV_CREDIT_CAP` (default 20000)
  aborts resolve before any Tatum call when the expected cost is higher.
- `@mysqlsui` and both `balance_threshold` claims are omitted.
- Each post keeps `source_url`. The feed links to it.

A rerun skips every post whose `seed_posts.applied_at` marker is set, so the
original 17 are not inserted again and are not written to Walrus again. Only
the new posts are ingested. Resolve checks a claim only while it is still
pending and past its deadline. Already-resolved replay claims are not checked
again. The log prints the expected cost and the worst case before resolve.
After resolve it prints the credits this run actually spent. A second run of
an already-seeded file observes 0.

Writes go one at a time through `rememberAndWait` with a stable idempotency
key (`claim:{id}`, `source:{id}`). Bulk items cannot carry that key. Do not
exceed the 30 points/min delegate limit; `memwalWriteLimiter` handles it.

Postgres is Coolify-internal. Run the seed in the worker container's terminal
after the image that contains this file is deployed. Boot applies migrations.
The container already has `DATABASE_URL`, `MEMWAL_PRIVATE_KEY`, and
`TATUM_API_KEY`. The image includes `scripts/`, `data/claims.json`, and `tsx`.

```bash
npm run seed
npm run list:memories
```

Stdout names the post (`post 3/30 <id>`), each memory write as it starts and
as it finishes (elapsed milliseconds and blob id), then the resolve phase,
then the summary. Exit 0 prints `status ok`. A non-zero exit prints
`status incomplete`, a `failed` list, and `not attempted` when a timeout
stopped the run before later posts. The process closes the database pool and
exits. A prompt coming back is the seed finishing.

### Rerun after an interrupted seed

A seed that died or timed out is safe to run again. Do not delete projection
rows or Walrus memories first.

The applied marker (`seed_posts.applied_at`) is written only after every
memory for that post has been recorded. A rerun skips a post whose marker is
set. A post that was inserted and then interrupted still has its claim rows;
the rerun writes only the memories that have no blob id, with the same
idempotency keys (`source:{id}`, `claim:{id}`). The relayer collapses a retry
of a key it already accepted, so the rerun does not append a second copy.
Posts listed as `not attempted` were never started; the rerun runs them.

What hung the first production run: `rememberAndWait`'s `timeoutMs` bounds the
status poll only. Before that poll starts, the SDK builds a SEAL session by
reading the package object from Sui (`SessionKey.create` → `getObject`), and
that read has no deadline. A stalled fullnode call never rejects, so the seed
printed nothing and the next claim was never inserted. Writes are now wrapped
in a deadline that aborts the fetch, retried with backoff on the same
idempotency key, and a timed-out post is left unmarked. The worker's ingest
and resolve writes go through the same wrapper.

Run the command above again in the worker container, on the image that
contains this fix. Then `npm run list:memories`. If the exit code is still
non-zero, the summary names the post or claim that failed; leave the rows in
place and run `npm run seed` once more.

On an empty delegate the run writes one source memory per handle (10), one
claim memory per claim (33), and a resolution for each of the 11 replays and
16 historical price claims whose deadlines have passed. The six open price
claims stay pending and write no resolution. A `void` writes a resolution and
no score. A `true` or `false` also writes a score memory. `list:memories`
prints the account total.

Production already has the first 17 posts applied. Run the commands above
once in the worker container after this image is deployed. That run skips
those 17, so it does not insert them again and does not write them to Walrus
again. It writes memories for the 13 new posts (3 new handles, 16 claims) and
then the resolutions and scores for those 16 historical price claims.

**Acceptance:** re-running `npm run seed` twice does not double the ledger, and
the Feed links each claim to its original post.

---

## Task 5 — Adjudication tests

`lib/score.test.ts` exists. Add `lib/adjudicate.test.ts`.

Cover, with fixed inputs and `now` injected:

- `balance_change_since_ingest` with `snapshot: null` → `void`, and the reason
  mentions the missing receipt
- deadline in the future → `void`
- Tatum throwing → `void`, never `false`
- `price_threshold` when the rate is undefined → `void` with the reason that
  the pair is unsupported
- `tx_replay` when `truncated` → `void`, because a floor is not a verdict

Mock `lib/tatum` with `vi.mock`. Do not hit the network in tests.

**Acceptance:** every one of the five cases above is a `void`, and none of them
changes a score.

---

## Task 6 — Replay fixtures

`DEMO_MODE=replay` must run the whole demo offline. `lib/tatum.ts` reads from
`fixtures/tatum/` and throws a clear error when a fixture is missing.

Run the app once with `DEMO_MODE=live CAPTURE_FIXTURES=1` against the seed data,
then commit `fixtures/tatum/`. Verify by disabling wifi or pointing
`TATUM_SUI_RPC_URL` at `http://127.0.0.1:1` with `DEMO_MODE=replay`.

**Acceptance:** the Feed and a resolution both work with no network.

---

## Task 7 — Verify the rate endpoint

With a real `TATUM_API_KEY`, run:

```bash
curl -s -H "x-api-key: $TATUM_API_KEY" \
  "https://api.tatum.io/v4/data/rate/symbol?symbol=SUI&basePair=USD"
```

If it returns a value, `price_threshold` stays. If it 404s or returns null,
remove `price_threshold` from `ClaimType`, from the extraction prompt's type
list, and from `lib/adjudicate.ts`, and add a line to the README explaining why.
Do not leave it half-working.

---

## Task 8 — Submission artefacts

- **README** already has the thesis and the constraints. Add: memory count with
  a blob id table, the measured latency numbers, and a "what changed because of
  memory" section with a before/after from the seed data.
- **Blog post.** Required sections: what it does, how it uses Tatum + Walrus,
  how it learned over time. The third one needs real numbers from the seed run —
  a score timeline and at least one "verdict 12 dropped source A from 1st to
  7th" example. Say plainly that snapshots were synthesised where they were.
- **Demo video, 2–3 minutes.** Four beats: problem 30s → write and recall 30s →
  **score changes and the feed changes** 60s → restore 20s. Open on the
  before/after diff, not on a logo.
- **X + LinkedIn**, tag `@Tatum_io` and `@WalrusFoundation`.

---

## Things that will bite

1. `remember()` has no `blob_id`. Use `rememberAndWait` or `rememberBulkAndWait`.
   That call's `timeoutMs` does not cover SEAL session setup (`getObject`).
   `writeMemory` adds the deadline. Do not call `rememberAndWait` from anywhere
   else.
2. `getPublicKeyHex()` is async.
3. Never write memories inside a page render or a request a user waits on.
4. `void` is not `false`. Every UI string must respect that or the trust model
   is a lie.
5. The repo is public. `MEMWAL_PRIVATE_KEY` is server-only; `lib/env.ts` throws
   if it is imported into client code. Do not defeat that guard.
6. Do not add `forget`/`clear`. They do not exist on the real client.
