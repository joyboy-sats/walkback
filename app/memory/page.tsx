/**
 * Memory Explorer.
 *
 * The proof-of-work screen for the Walrus Memory prize: every memory ever
 * written, with its blob id. A judge should be able to count them and see that
 * they exist on mainnet, not just that the app claims to have written them.
 *
 * Design: the blob log is the object. It is rendered as a dense ledger table
 * with tabular figures so the id column scans as a column, not as noise.
 */
import { apiGet } from "@/lib/public-api";
import RebuildButton from "./rebuild-button";
import { ArchiveIllustration, LedgerIllustration } from "@/components/illustrations";
import { HaloBadge } from "@/components/ui/halo-badge";

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

const KIND_ORDER = ["source", "claim", "resolution", "score", "digest", "tombstone"];

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

  const byNamespace = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.namespace] = (acc[r.namespace] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <section className="relative mb-6 overflow-hidden rounded-2xl border border-line bg-surface-1">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.035]"
          style={{
            backgroundImage:
              "linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)",
            backgroundSize: "28px 28px",
          }}
        />
        <div className="relative grid items-center gap-6 px-6 py-7 sm:grid-cols-[1fr_200px] sm:px-8">
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-2.5">
              <HaloBadge variant="secondary" tabularNums live>
                {rows.length} memories
              </HaloBadge>
              <span className="label">Walrus Memory · mainnet</span>
            </div>
            <h1 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.025em]">
              The ledger behind the ledger.
            </h1>
            <p className="mt-3 max-w-[58ch] text-[14px] leading-relaxed text-ink-2">
              Every claim, verdict and score version is written to Walrus Memory on
              mainnet. Walrus is the system of record; the Postgres tables the rest
              of the app reads are a rebuildable projection of it.
            </p>
          </div>
          <div className="hidden justify-self-end sm:block">
            <ArchiveIllustration className="h-[130px] w-[165px]" />
          </div>
        </div>
      </section>

      {/* ── KPI ────────────────────────────────────────────────────────── */}
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-4">
        <Kpi label="memories" value={String(rows.length)} />
        <Kpi label="namespaces" value={String(Object.keys(byNamespace).length)} />
        <Kpi label="kinds" value={String(Object.keys(byKind).length)} />
        <Kpi
          label="score versions"
          value={String(byKind.score ?? 0)}
          hint="not decrypted on rebuild"
        />
      </dl>

      {/* ── Kind distribution ──────────────────────────────────────────── */}
      {rows.length > 0 && (
        <section className="mt-5">
          <p className="label mb-2.5">distribution</p>
          <div className="flex flex-wrap gap-1.5">
            {KIND_ORDER.filter((k) => byKind[k]).map((k) => (
              <span
                key={k}
                className="inline-flex items-center gap-2 rounded-md border border-line bg-surface-1 px-2.5 py-1.5"
              >
                <span className="mono text-[11px] text-ink-2">{k}</span>
                <span className="tnum text-[12px] font-medium">{byKind[k]}</span>
              </span>
            ))}
            {Object.keys(byKind)
              .filter((k) => !KIND_ORDER.includes(k))
              .map((k) => (
                <span
                  key={k}
                  className="inline-flex items-center gap-2 rounded-md border border-line bg-surface-1 px-2.5 py-1.5"
                >
                  <span className="mono text-[11px] text-ink-3">{k}</span>
                  <span className="tnum text-[12px] font-medium">{byKind[k]}</span>
                </span>
              ))}
          </div>
        </section>
      )}

      {/* ── Verify / rebuild ───────────────────────────────────────────── */}
      <section className="mt-8 overflow-hidden rounded-lg border border-line">
        <div className="border-b border-line bg-surface-1 px-4 py-3">
          <div className="flex items-center gap-2">
            <LedgerIllustration className="h-4 w-5 text-ink-3" muted />
            <h2 className="text-[14px] font-medium">Verify against Walrus</h2>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
            Pages the relayer inventory and compares it with Postgres, record by
            record. Replacing the projection stays unavailable until every live
            product-namespace memory was read, the rebuild would not shrink any
            table, and no seed post is unfinished.
          </p>
        </div>
        <div className="bg-surface-0 px-4 py-4">
          {loadError ? (
            <p className="text-[13px] text-false">{loadError}</p>
          ) : (
            <p className="mb-4 text-[11px] leading-relaxed text-ink-3">{limitation}</p>
          )}
          <RebuildButton />
        </div>
      </section>

      {/* ── Blob log ───────────────────────────────────────────────────── */}
      <section className="mt-10">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="label">written</h2>
          <span className="text-[11px] text-ink-3">
            newest first · {rows.length} row{rows.length === 1 ? "" : "s"}
          </span>
        </div>

        {rows.length === 0 ? (
          <p className="text-[13px] text-ink-3">
            No memories in the projection yet. Ingest a post to write the first one.
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-line">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-line bg-surface-1">
                  <th className="label px-3 py-2 font-medium">kind</th>
                  <th className="label hidden px-3 py-2 font-medium sm:table-cell">namespace</th>
                  <th className="label px-3 py-2 font-medium">blob</th>
                  <th className="label hidden px-3 py-2 font-medium md:table-cell">preview</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    className="border-b border-line last:border-0 transition-colors hover:bg-surface-1"
                  >
                    <td className="px-3 py-2 align-middle">
                      <span className="mono text-[11px] text-ink-2">{r.kind}</span>
                    </td>
                    <td className="hidden px-3 py-2 align-middle sm:table-cell">
                      <span className="mono text-[11px] text-ink-3">{r.namespace}</span>
                    </td>
                    <td className="px-3 py-2 align-middle">
                      <span className="mono text-[11px] text-ink-2" title={r.blobId}>
                        {r.blobId.length > 22 ? `${r.blobId.slice(0, 22)}…` : r.blobId}
                      </span>
                    </td>
                    <td className="hidden px-3 py-2 align-middle md:table-cell">
                      <span className="block max-w-[46ch] truncate text-[12px] text-ink-3">
                        {r.textPreview}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-surface-1 px-4 py-3">
      <dt className="label">{label}</dt>
      <dd className="mt-1.5 flex items-baseline gap-2">
        <span className="tnum text-[19px] font-medium tracking-[-0.01em]">{value}</span>
        {hint && <span className="text-[11px] text-ink-3">{hint}</span>}
      </dd>
    </div>
  );
}
