/**
 * Recompute category counts and the muted flag from stored resolutions.
 *
 * Run this in the Coolify worker container after the image with migration
 * 0005 is deployed. Worker boot applies the migration. Postgres is not
 * reachable from a laptop.
 *
 *   npm run rescore
 *
 * Reads resolutions only. Does not call Tatum. Does not write Walrus.
 * Does not insert a score version and does not rewrite an existing memory.
 * `hits` / `misses` / `score` stay the overall Wilson record. `muted` follows
 * forecast-primary: the forecast band when the source has a price verdict,
 * otherwise the reporting band.
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

const { eq } = await import("drizzle-orm");
const { closeDb, getDb } = await import("../lib/db");
const { claims, resolutions, sources } = await import("../lib/db/schema");
const { foldVerdicts } = await import("../lib/category-score");
const { latestResolution } = await import("../lib/reads");
const { finishScript } = await import("../lib/script-exit");

let code = 0;
try {
  const db = getDb();
  const [sourceRows, claimRows, resolutionRows] = await Promise.all([
    db.select().from(sources),
    db
      .select({
        id: claims.id,
        sourceId: claims.sourceId,
        claimType: claims.claimType,
      })
      .from(claims),
    db
      .select({
        claimId: resolutions.claimId,
        outcome: resolutions.outcome,
        resolvedAt: resolutions.resolvedAt,
      })
      .from(resolutions),
  ]);
  const latest = latestResolution(resolutionRows);
  const claimById = new Map(claimRows.map((row) => [row.id, row]));

  console.log(`rescore ${sourceRows.length} source(s) from ${latest.size} resolution(s); no Tatum, no Walrus`);
  for (const source of sourceRows.sort((a, b) => a.handle.localeCompare(b.handle))) {
    const verdicts: Array<{ claimType: string; outcome: "true" | "false" | "void" }> = [];
    for (const resolution of latest.values()) {
      const claim = claimById.get(resolution.claimId);
      if (!claim || claim.sourceId !== source.id) continue;
      verdicts.push({ claimType: claim.claimType, outcome: resolution.outcome });
    }
    const folded = foldVerdicts(verdicts);
    await db
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
    console.log(
      `${source.handle}  basis=${folded.muteBasis}  muted=${folded.muted}  ` +
        `reporting ${folded.reporting.hits}/${folded.reporting.misses} ${folded.reporting.band} ${folded.reporting.score.toFixed(4)}  ` +
        `forecast ${folded.forecast.hits}/${folded.forecast.misses} ${folded.forecast.band} ${folded.forecast.score.toFixed(4)}  ` +
        `overall ${folded.overall.hits}/${folded.overall.misses} ${folded.overall.band} ${folded.overall.score.toFixed(4)}`,
    );
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  code = 1;
}

await finishScript(code, { close: () => closeDb() });
