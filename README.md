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

Early scaffold. The identity model, memory layer and adjudication contract are
settled; the Next.js app is not built yet.

What works today:

- `npm run smoke` — proves the Walrus Memory mainnet delegate key works end to
  end (health → write → recall) and prints the delegate public key you need for
  the submission form.

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
| Postgres (Neon) | queryable projection: sources, claims, resolutions, score versions | fast reads for the UI |
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

## Known open questions

- `price_threshold` depends on the Tatum rate endpoint supporting `symbol=SUI`.
  The endpoint requires auth, so this is unverified until a key exists. If Sui
  is unsupported, the claim type gets disabled in config rather than shipped
  broken.
- `restore()` has no pagination cursor and costs seconds per blob; large
  namespaces may not fully restore in one call.

## License

MIT
