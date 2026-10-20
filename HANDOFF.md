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
- `app/`: Feed, Source detail, Memory Explorer, three API routes.
- `npm run typecheck`, `npm run test`, `npm run build` all pass.

**Blocks that need a human, not an agent**

- `TATUM_API_KEY` has never been exercised. `price_threshold` support for
  `symbol=SUI` is unverified; the endpoint needs auth.
- `AI_GATEWAY_API_KEY` is unset, so extraction has never run.
- `DATABASE_URL` is unset, so the projection has never been created.
- `MEMWAL_AGENT_ID` is assumed to be the delegate public key. Unconfirmed.

---

## Task 1 — Database bootstrap

Create a Neon database, set `DATABASE_URL`, then:

```bash
npm run db:generate
npm run db:push
```

**Acceptance:** `\dt` in psql shows `sources`, `claims`, `resolutions`,
`score_versions`, `memory_log` and the three enums. Commit the generated
migration folder.

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

Write `scripts/seed.ts`. Without this there is no "learned over time" story and
the demo has nothing to show.

Target: 10–15 sources, 40–60 claims, a realistic mix of correct and incorrect.

Two sources of data, both legitimate, both must be labelled as such in the blog:

- **Synthetic snapshots (majority).** Construct claims whose snapshots encode a
  known starting balance, and whose current balance is real and readable
  through Tatum. The time is injected; the numbers are real.
- **True replay (minority).** Pick real addresses and adjudicate a historical
  claim through `tx_replay`.

Rules:

- Use `writeMemoriesBulk`, 20 per call. A single write is 24s; do not loop.
- Pass stable `idempotencyKey`s so re-running does not duplicate.
- Print a summary at the end: memory count per namespace, blob ids, and the
  final score per source.
- Do not exceed the 30 points/min delegate limit; `memwalWriteLimiter` handles
  it, but do not bypass it.

**Acceptance:** re-running `npm run seed` twice does not double the ledger, and
the Feed visibly reorders between sources with different records.

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
2. `getPublicKeyHex()` is async.
3. Never write memories inside a page render or a request a user waits on.
4. `void` is not `false`. Every UI string must respect that or the trust model
   is a lie.
5. The repo is public. `MEMWAL_PRIVATE_KEY` is server-only; `lib/env.ts` throws
   if it is imported into client code. Do not defeat that guard.
6. Do not add `forget`/`clear`. They do not exist on the real client.
