/**
 * Read-only index of a listed memory.
 *
 * The relayer list returns namespace and blob id. It does not return the
 * idempotency key. The key is the one this product would have sent, derived
 * from the fenced JSON. No memory text is included in the line.
 */
import { parseFencedJson, resolutionIdempotencyKey, scoreIdempotencyKey } from "./stored-resolution";

export interface MemoryIndex {
  kind: string;
  refId: string;
  idempotencyKey: string;
}

export function wantsMemoryIndex(argv: readonly string[]): boolean {
  return argv.includes("--keys") || argv.includes("--verbose");
}

export function indexMemoryText(namespace: string, text: string | undefined): MemoryIndex {
  const fallbackKind = namespace.startsWith("walkback.") ? namespace.slice("walkback.".length) : namespace || "unknown";
  const payload = text ? parseFencedJson(text) : null;
  if (!payload) return { kind: fallbackKind, refId: "-", idempotencyKey: "-" };
  const kind = typeof payload.kind === "string" && payload.kind.length > 0 ? payload.kind : fallbackKind;

  if (kind === "claim" && isId(payload.claim_id)) {
    return { kind, refId: payload.claim_id, idempotencyKey: `claim:${payload.claim_id}` };
  }
  if (kind === "source" && isId(payload.source_id)) {
    return { kind, refId: payload.source_id, idempotencyKey: `source:${payload.source_id}` };
  }
  if (kind === "resolution" && isId(payload.claim_id)) {
    const revision = positiveInt(payload.revision) ?? 1;
    return { kind, refId: payload.claim_id, idempotencyKey: resolutionIdempotencyKey(payload.claim_id, revision) };
  }
  if (kind === "score" && isId(payload.source_id) && positiveInt(payload.version) !== null) {
    return {
      kind,
      refId: payload.source_id,
      idempotencyKey: scoreIdempotencyKey(payload.source_id, positiveInt(payload.version)!),
    };
  }
  if (kind === "digest" && typeof payload.date === "string" && payload.date.length > 0) {
    return { kind, refId: payload.date, idempotencyKey: `digest:${payload.date}` };
  }
  if (
    kind === "tombstone" &&
    isId(payload.ref_id) &&
    (payload.ref_kind === "source" || payload.ref_kind === "claim")
  ) {
    return { kind, refId: payload.ref_id, idempotencyKey: `tombstone:${payload.ref_kind}:${payload.ref_id}` };
  }
  return { kind, refId: "-", idempotencyKey: "-" };
}

export function formatMemoryIndexLine(index: MemoryIndex): string {
  return `${index.kind} ${index.refId} ${index.idempotencyKey}`;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}
