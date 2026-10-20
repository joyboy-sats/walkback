/**
 * Feed — claims ranked by their source's trust.
 *
 * The one screen that has to demonstrate the product thesis: a source that was
 * wrong is *visible as demoted*, and one that is below the mute threshold is
 * collapsed rather than shown normally.
 *
 * Server component; reads straight from the projection.
 */
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { MIN_SAMPLE, TRUST_MUTED, TRUST_TRUSTED, trustBand } from "@/lib/score";

export const dynamic = "force-dynamic";

function bandLabel(score: number, adjudicated: number): {
  text: string;
  className: string;
} {
  const band = trustBand(score, adjudicated);
  switch (band) {
    case "trusted":
      return { text: "trusted", className: "text-[var(--good)]" };
    case "muted":
      return { text: "muted", className: "text-[var(--bad)]" };
    case "unknown":
      return { text: "unrated", className: "text-[var(--void)]" };
    default:
      return { text: "normal", className: "text-[var(--dim)]" };
  }
}

export default async function FeedPage() {
  const db = getDb();

  const rows = await db
    .select({
      claim: schema.claims,
      source: schema.sources,
    })
    .from(schema.claims)
    .innerJoin(schema.sources, eq(schema.claims.sourceId, schema.sources.id))
    .orderBy(desc(schema.sources.score), desc(schema.claims.deadline))
    .limit(100);

  const muted = rows.filter((r) => !r.source.muted);
  const hidden = rows.length - muted.length;

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Feed</h1>
        <p className="mt-2 text-sm text-[var(--dim)] max-w-2xl">
          Claims from sources you follow, ranked by how often that source has been
          right. A source drops below {TRUST_MUTED.toFixed(2)} and its claims stop
          appearing. Trust is a Wilson lower bound over adjudicated claims, so a
          single correct guess earns nothing.
        </p>
      </div>

      {muted.length === 0 ? (
        <p className="text-[var(--dim)]">
          No claims yet. Ingest a post to start the ledger.
        </p>
      ) : (
        <ul className="space-y-3">
          {muted.map(({ claim, source }) => {
            const adjudicated = source.hits + source.misses;
            const band = bandLabel(source.score, adjudicated);
            return (
              <li
                key={claim.id}
                className="border border-[var(--line)] rounded-lg p-4 hover:border-[var(--dim)] transition-colors"
              >
                <div className="flex items-baseline gap-3 text-sm">
                  <a
                    href={`/sources/${source.id}`}
                    className="font-medium hover:underline"
                  >
                    {source.handle}
                  </a>
                  <span className={`text-xs ${band.className}`}>
                    {band.text} · {source.score.toFixed(2)}
                  </span>
                  {adjudicated < MIN_SAMPLE && (
                    <span className="text-xs text-[var(--void)]">
                      {adjudicated}/{MIN_SAMPLE} claims judged
                    </span>
                  )}
                  <span className="ml-auto text-xs text-[var(--dim)] mono">
                    due {claim.deadline.toISOString().slice(0, 10)}
                  </span>
                </div>

                <blockquote className="mt-3 border-l-2 border-[var(--line)] pl-3 text-[15px] leading-relaxed">
                  “{claim.quote}”
                </blockquote>

                <div className="mt-3 flex items-center gap-3 text-xs text-[var(--dim)]">
                  <span className="pill">{claim.claimType}</span>
                  <span className={claim.status === "resolved" ? "text-[var(--good)]" : ""}>
                    {claim.status}
                  </span>
                  {claim.walrusBlobId && (
                    <span className="mono text-[var(--void)]">
                      blob {claim.walrusBlobId.slice(0, 12)}…
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {hidden > 0 && (
        <p className="mt-6 text-sm text-[var(--dim)]">
          {hidden} claim{hidden === 1 ? "" : "s"} hidden from muted sources.
        </p>
      )}

      <p className="mt-10 text-xs text-[var(--void)]">
        Muted below {TRUST_MUTED.toFixed(2)} · trusted at {TRUST_TRUSTED.toFixed(2)} and above
      </p>
    </div>
  );
}
