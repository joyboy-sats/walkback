/**
 * Recompute category counts and the muted flag from stored resolutions,
 * and fill a null `claims.published_at` from `data/claims.json`.
 *
 * Run this in the Coolify worker container after the image with migrations
 * 0005 and 0006 is deployed. Worker boot applies the migrations. Postgres is
 * not reachable from a laptop.
 *
 *   npm run rescore
 *
 * One transaction. Before it reads counts it takes the same claim advisory
 * locks the resolver takes (`walkback.resolve:{claimId}`), as transaction
 * locks, and holds them until commit. A resolver's `pg_try_advisory_lock`
 * then fails, and a resolver that already holds the lock makes this wait,
 * so this write cannot replace a tally the resolver just committed. The
 * locks are taken before any row lock. The resolver locks the claim row and
 * then updates the source, so this does the same: claim rows, then sources.
 *
 * It does not take the MemWal write lock. It does not call Tatum. It does
 * not write Walrus. It does not insert a score version and does not rewrite
 * an existing memory. `hits` / `misses` / `score` stay the overall Wilson
 * record. `muted` follows forecast-primary. `published_at` is filled only
 * where it is null, and only from the seed file. `params.since` is not a
 * post time.
 */
import "dotenv/config";
import { config } from "dotenv";
config({ path: ".env.local" });

if (!process.env.DATABASE_URL?.trim()) {
  console.error(
    "DATABASE_URL is not set.\n" +
      "Run this in the Coolify worker container's terminal. That process already has DATABASE_URL.\n" +
      "The database is on Coolify's internal network, so a laptop cannot open it.",
  );
  process.exit(1);
}

const { and, asc, eq, isNull, sql } = await import("drizzle-orm");
const { closeDb, getDb } = await import("../lib/db");
const { claims, resolutions, sources } = await import("../lib/db/schema");
const { foldVerdicts } = await import("../lib/category-score");
const { seedPublishedAt } = await import("../lib/post-time");
const { latestResolution } = await import("../lib/reads");
const { advisoryLockKeys, claimResolveLockName } = await import("../lib/resolve-lock");
const { finishScript } = await import("../lib/script-exit");

let code = 0;
try {
  const db = getDb();
  const lines = await db.transaction(async (tx) => {
    const locked = new Set<string>();
    for (;;) {
      const ids = await tx.select({ id: claims.id }).from(claims);
      const missing = ids
        .map((row) => row.id)
        .filter((id) => !locked.has(id))
        .sort();
      if (missing.length === 0) break;
      for (const id of missing) {
        const [k1, k2] = advisoryLockKeys(claimResolveLockName(id));
        await tx.execute(sql`select pg_advisory_xact_lock(${k1}::int, ${k2}::int)`);
        locked.add(id);
      }
    }

    await tx.select({ id: claims.id }).from(claims).orderBy(asc(claims.id)).for("update");
    await tx.select({ id: sources.id }).from(sources).orderBy(asc(sources.id)).for("update");

    const sourceRows = await tx.select().from(sources);
    const claimRows = await tx
      .select({
        id: claims.id,
        sourceId: claims.sourceId,
        claimType: claims.claimType,
        externalId: claims.externalId,
        sourceUrl: claims.sourceUrl,
        publishedAt: claims.publishedAt,
      })
      .from(claims);
    const resolutionRows = await tx
      .select({
        claimId: resolutions.claimId,
        outcome: resolutions.outcome,
        resolvedAt: resolutions.resolvedAt,
      })
      .from(resolutions);

    let filled = 0;
    for (const claim of claimRows) {
      if (claim.publishedAt) continue;
      const published = seedPublishedAt(claim.externalId, claim.sourceUrl);
      if (!published) continue;
      await tx
        .update(claims)
        .set({ publishedAt: new Date(published) })
        .where(and(eq(claims.id, claim.id), isNull(claims.publishedAt)));
      filled += 1;
    }

    const latest = latestResolution(resolutionRows);
    const claimById = new Map(claimRows.map((row) => [row.id, row]));
    const out = [
      `rescore ${sourceRows.length} source(s) from ${latest.size} resolution(s); published_at filled ${filled}; no Tatum, no Walrus`,
    ];
    for (const source of sourceRows.sort((a, b) => a.handle.localeCompare(b.handle))) {
      const verdicts: Array<{ claimType: string; outcome: "true" | "false" | "void" }> = [];
      for (const resolution of latest.values()) {
        const claim = claimById.get(resolution.claimId);
        if (!claim || claim.sourceId !== source.id) continue;
        verdicts.push({ claimType: claim.claimType, outcome: resolution.outcome });
      }
      const folded = foldVerdicts(verdicts);
      await tx
        .update(sources)
        .set({
          hits: folded.overall.hits,
          misses: folded.overall.misses,
          score: folded.overall.score,
          muted: folded.muted,
          reportingHits: folded.reporting.hits,
          reportingMisses: folded.reporting.misses,
          forecastHits: folded.forecast.hits,
          forecastMisses: folded.forecast.misses,
        })
        .where(eq(sources.id, source.id));
      out.push(
        `${source.handle}  basis=${folded.muteBasis}  muted=${folded.muted}  ` +
          `reporting ${folded.reporting.hits}/${folded.reporting.misses} ${folded.reporting.band} ${folded.reporting.score.toFixed(4)}  ` +
          `forecast ${folded.forecast.hits}/${folded.forecast.misses} ${folded.forecast.band} ${folded.forecast.score.toFixed(4)}  ` +
          `overall ${folded.overall.hits}/${folded.overall.misses} ${folded.overall.band} ${folded.overall.score.toFixed(4)}`,
      );
    }
    return out;
  });
  for (const line of lines) console.log(line);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  code = 1;
}

await finishScript(code, { close: () => closeDb() });
