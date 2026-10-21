/**
 * Coolify API. The only HTTP process that opens Postgres.
 *
 * Vercel fetches this origin (`NEXT_PUBLIC_API_URL`). It never receives
 * DATABASE_URL. Writes wait for `x-admin-token`. The worker, not this
 * process, talks to Walrus.
 *
 *   GET  /health
 *   GET  /feed
 *   GET  /sources/:id
 *   GET  /memory
 *   GET  /jobs/:id
 *   POST /ingest     x-admin-token, enqueues
 *   POST /rebuild    x-admin-token, enqueues
 *   POST /resolve    x-admin-token, enqueues
 *   POST /restore    x-admin-token, enqueues
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { boot } from "../backend/boot";
import { ingestBody } from "../lib/ingest-body";
import { enqueueJob, readJob } from "../lib/job-queue";
import { corsHeaders, preflightStatus, tokenMatches } from "../lib/http-guard";
import { claimsForSourceUrls, readFeed, readMemory, readSource } from "../lib/reads";
import { NS } from "../lib/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const resolveBody = z.union([
  z.object({
    claimId: z.string().uuid(),
    supersede: z.boolean().optional(),
    force: z.boolean().optional(),
  }),
  z.object({ due: z.literal(true), limit: z.number().int().min(1).max(25).optional() }),
  z.object({
    supersede: z.literal(true),
    force: z.boolean().optional(),
    sourceUrls: z.array(z.string().url()).min(1).max(20),
  }),
]);

const rebuildBody = z.object({
  mode: z.enum(["verify", "rebuild"]).optional(),
  confirm: z.boolean().optional(),
  allowShrink: z.boolean().optional(),
});

const restoreBody = z.object({
  namespace: z.enum([NS.source, NS.claim, NS.resolution, NS.score, NS.digest, NS.tombstone]).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

interface Config {
  port: number;
  token: string;
  origins: string[];
}

function config(): Config {
  const token = process.env.ADMIN_TOKEN ?? "";
  if (token.length < 16) {
    throw new Error("ADMIN_TOKEN is required and must be at least 16 characters");
  }
  const origins = (process.env.CORS_ORIGIN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    throw new Error(
      "CORS_ORIGIN is required. Set it to the Vercel frontend origin, for example https://<project>.vercel.app. " +
        "More than one origin is comma-separated, for example https://a.vercel.app,https://b.vercel.app.",
    );
  }
  const port = Number(process.env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1) throw new Error("PORT must be a positive integer");
  return { port, token, origins };
}

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...extra });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text) as unknown;
}

function headerToken(req: IncomingMessage): string | undefined {
  const header = req.headers["x-admin-token"];
  return Array.isArray(header) ? header[0] : header;
}

function dbDetail(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("DATABASE_URL") ? message : "database unavailable";
}

async function handle(req: IncomingMessage, res: ServerResponse, cfg: Config): Promise<void> {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  const cors = corsHeaders(origin, cfg.origins);
  if (req.method === "OPTIONS") {
    const status = preflightStatus(origin, cfg.origins);
    if (status === 403) {
      res.writeHead(403, { vary: "origin" });
      res.end();
      return;
    }
    res.writeHead(204, cors);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname.replace(/\/$/, "") || "/";

  try {
    if (req.method === "GET" && path === "/health") {
      send(res, 200, { ok: true }, cors);
      return;
    }

    if (req.method === "GET" && path === "/feed") {
      send(res, 200, await readFeed(), cors);
      return;
    }

    if (req.method === "GET" && path === "/memory") {
      send(res, 200, await readMemory(), cors);
      return;
    }

    const sourceId = path.match(/^\/sources\/([^/]+)$/)?.[1];
    if (req.method === "GET" && sourceId) {
      if (!UUID.test(sourceId)) {
        send(res, 404, { error: "not found" }, cors);
        return;
      }
      const row = await readSource(sourceId);
      if (!row) {
        send(res, 404, { error: "not found" }, cors);
        return;
      }
      send(res, 200, row, cors);
      return;
    }

    const jobId = path.match(/^\/jobs\/([^/]+)$/)?.[1];
    if (req.method === "GET" && jobId) {
      if (!UUID.test(jobId)) {
        send(res, 404, { error: "not found" }, cors);
        return;
      }
      const job = await readJob(jobId);
      if (!job) {
        send(res, 404, { error: "not found" }, cors);
        return;
      }
      send(res, 200, job, cors);
      return;
    }

    if (req.method === "POST" && (path === "/ingest" || path === "/rebuild" || path === "/resolve" || path === "/restore")) {
      if (!tokenMatches(headerToken(req), cfg.token)) {
        send(res, 401, { error: "unauthorized" }, cors);
        return;
      }
      const raw = await readBody(req);
      if (path === "/ingest") {
        const parsed = ingestBody.parse(raw);
        const id = await enqueueJob("ingest", {
          ...parsed,
          publishedAt: parsed.publishedAt ?? new Date().toISOString(),
        });
        send(res, 202, { jobId: id }, cors);
        return;
      }
      if (path === "/rebuild") {
        const parsed = rebuildBody.parse(raw);
        const id = await enqueueJob("rebuild", {
          mode: parsed.mode ?? "verify",
          confirm: parsed.confirm === true,
          allowShrink: parsed.allowShrink === true,
        });
        send(res, 202, { jobId: id }, cors);
        return;
      }
      if (path === "/resolve") {
        const parsed = resolveBody.parse(raw);
        if ("sourceUrls" in parsed) {
          const rows = await claimsForSourceUrls(parsed.sourceUrls);
          const found = new Set(rows.map((row) => row.sourceUrl));
          const missing = parsed.sourceUrls.filter((url) => !found.has(url));
          if (missing.length > 0 || rows.length === 0) {
            send(res, 400, { error: "unknown source url", missing }, cors);
            return;
          }
          const id = await enqueueJob("resolve", {
            claimIds: rows.map((row) => row.id),
            supersede: true,
            force: parsed.force === true,
            limit: rows.length,
          });
          send(res, 202, { jobId: id, claimIds: rows.map((row) => row.id) }, cors);
          return;
        }
        const id = await enqueueJob("resolve", parsed);
        send(res, 202, { jobId: id }, cors);
        return;
      }
      const parsed = restoreBody.parse(raw);
      const id = await enqueueJob("restore", parsed);
      send(res, 202, { jobId: id }, cors);
      return;
    }

    send(res, 404, { error: "not found" }, cors);
  } catch (err) {
    const invalid = err instanceof z.ZodError || err instanceof SyntaxError;
    send(
      res,
      invalid ? 400 : 500,
      { error: invalid ? "invalid body" : "request failed", detail: invalid ? (err instanceof Error ? err.message : String(err)) : dbDetail(err) },
      cors,
    );
  }
}

const cfg = config();
await boot();

const server = createServer((req, res) => {
  void handle(req, res, cfg);
});

server.listen(cfg.port, "0.0.0.0", () => {
  console.log(`api listening on 0.0.0.0:${cfg.port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
