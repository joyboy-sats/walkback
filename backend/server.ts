/**
 * Coolify API.
 *
 * Vercel cannot open the private Postgres, so this process is the only HTTP
 * surface for the UI. It answers reads directly and turns writes into jobs.
 * The worker, not this process, talks to Walrus.
 *
 *   GET  /health
 *   GET  /feed
 *   GET  /sources/:id
 *   GET  /memory
 *   GET  /jobs/:id
 *   POST /ingest     bearer required, enqueues
 *   POST /rebuild    bearer required, enqueues
 *   POST /resolve    bearer required, enqueues
 *   POST /restore    bearer required, enqueues
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { authorizeBearer, corsHeaders } from "../lib/api-auth";
import { ingestBody } from "../lib/ingest-body";
import { NS } from "../lib/types";
import { boot } from "./boot";
import { enqueueJob, readJob } from "./jobs";
import { readFeed, readMemory, readSource } from "./read";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const resolveBody = z.union([
  z.object({ claimId: z.string().uuid() }),
  z.object({ due: z.literal(true), limit: z.number().int().min(1).max(25).optional() }),
]);

const restoreBody = z.object({
  namespace: z.enum([NS.source, NS.claim, NS.resolution, NS.score, NS.digest, NS.tombstone]).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

interface Config {
  port: number;
  secret: string;
  origins: string[];
}

function config(): Config {
  const secret = process.env.API_SHARED_SECRET ?? "";
  if (secret.length < 16) {
    throw new Error("API_SHARED_SECRET is required and must be at least 16 characters");
  }
  const origin = process.env.CORS_ORIGIN ?? "";
  const origins = origin
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    throw new Error("CORS_ORIGIN is required (the Vercel origin, comma-separated if more than one)");
  }
  const port = Number(process.env.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1) throw new Error("PORT must be a positive integer");
  return { port, secret, origins };
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

function authorized(req: IncomingMessage, cfg: Config): boolean {
  const header = req.headers.authorization;
  return authorizeBearer(Array.isArray(header) ? header[0] : header, cfg.secret);
}

async function handle(req: IncomingMessage, res: ServerResponse, cfg: Config): Promise<void> {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  const cors = corsHeaders(origin, cfg.origins);
  if (req.method === "OPTIONS") {
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
      if (!authorized(req, cfg)) {
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
        const id = await enqueueJob("rebuild", {});
        send(res, 202, { jobId: id }, cors);
        return;
      }
      if (path === "/resolve") {
        const parsed = resolveBody.parse(raw);
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
      {
        error: invalid ? "invalid body" : "request failed",
        detail: err instanceof Error ? err.message : String(err),
      },
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
