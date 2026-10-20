/**
 * Memory Explorer.
 *
 * The proof-of-work screen for the Walrus Memory prize: every memory ever
 * written, with its blob id, plus a restore button that rebuilds from mainnet.
 *
 * Deliberately shows `blob_id` next to each row. A judge should be able to
 * count the memories and see that they exist on mainnet, not just that the app
 * claims to have written them.
 */
import { apiGet } from "@/lib/public-api";
import RebuildButton from "./rebuild-button";

interface MemoryView {
  rows: Array<{
    id: string;
    kind: string;
    namespace: string;
    blobId: string;
    textPreview: string;
  }>;
  limitation: string;
}

export const dynamic = "force-dynamic";

export default async function MemoryPage() {
  let view: MemoryView | null = null;
  let loadError: string | null = null;
  try {
    view = await apiGet<MemoryView>("/memory");
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  const rows = view?.rows ?? [];
  const limitation = view?.limitation ?? "";

  const byKind = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.kind] = (acc[r.kind] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Memory</h1>
        <p className="mt-2 text-sm text-[var(--dim)] max-w-2xl">
          Every claim, verdict and score version is written to Walrus Memory on
          mainnet. Walrus is the system of record; the Postgres tables the rest of
          the app reads are a rebuildable projection of it.
        </p>
      </div>

      <section className="border border-[var(--line)] rounded-lg p-4">
        <h2 className="text-sm text-[var(--dim)]">rebuild the projection</h2>
        <p className="mt-2 text-sm max-w-2xl">
          Drops the five Postgres tables and writes them again from the memories
          on Walrus. Scores are recomputed from verdicts. A void still does not
          count. The button asks for the admin token once per tab, the same
          ADMIN_TOKEN the ingest page uses.
        </p>
        {loadError ? (
          <p className="mt-2 text-sm text-[var(--bad)]">{loadError}</p>
        ) : (
          <p className="mt-2 text-xs text-[var(--void)] max-w-2xl">{limitation}</p>
        )}
        <RebuildButton />
      </section>

      <section className="mt-4 border border-[var(--line)] rounded-lg p-4">
        <h2 className="text-sm text-[var(--dim)]">on the relayer</h2>
        <p className="mt-2 text-sm max-w-2xl">
          Namespace counts live with the delegate key on the worker. This page
          lists the projection’s memory log, which is rebuilt from those writes.
        </p>
      </section>

      <section className="mt-4 flex flex-wrap gap-2 text-xs text-[var(--dim)]">
        {Object.entries(byKind).map(([kind, n]) => (
          <span key={kind} className="border border-[var(--line)] rounded px-2 py-1">
            {kind} {n}
          </span>
        ))}
        <span className="ml-auto text-[var(--void)]">
          {rows.length} row{rows.length === 1 ? "" : "s"} in projection
        </span>
      </section>

      <section className="mt-4">
        <h2 className="text-sm text-[var(--dim)] mb-2">written</h2>
        <ul className="space-y-1">
          {rows.map((r) => (
            <li
              key={r.id}
              className="border border-[var(--line)] rounded px-3 py-2 text-xs flex items-baseline gap-3"
            >
              <span className="text-[var(--void)] w-20 shrink-0">{r.kind}</span>
              <span className="text-[var(--dim)] w-44 shrink-0 truncate">{r.namespace}</span>
              <span className="mono text-[var(--void)] shrink-0">
                {r.blobId.slice(0, 20)}…
              </span>
              <span className="truncate text-[var(--dim)]">{r.textPreview}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
