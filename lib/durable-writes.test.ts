import { describe, expect, it, vi } from "vitest";
import { pendingWrites, writeDurable } from "./durable-writes";

describe("pendingWrites", () => {
  it("drops items whose blob id was already recorded", () => {
    const writes = [
      { idempotencyKey: "claim:a" },
      { idempotencyKey: "claim:b" },
      { idempotencyKey: "source:s" },
    ];
    const pending = pendingWrites(writes, new Set(["claim:a", "source:s"]));
    expect(pending.map((w) => w.idempotencyKey)).toEqual(["claim:b"]);
  });
});

describe("writeDurable", () => {
  it("records each success before the next item and does not send the rest after a failure", async () => {
    const order: string[] = [];
    const writeOne = vi.fn(async (item: { idempotencyKey: string }) => {
      order.push(`write:${item.idempotencyKey}`);
      if (item.idempotencyKey === "claim:c") throw new Error("relayer rejected c");
      return { blobId: `blob-${item.idempotencyKey}`, id: `id-${item.idempotencyKey}` };
    });
    const onPersisted = vi.fn(async (item: { idempotencyKey: string }) => {
      order.push(`record:${item.idempotencyKey}`);
    });

    const items = ["a", "b", "c", "d"].map((id) => ({ idempotencyKey: `claim:${id}` }));
    const result = await writeDurable(items, writeOne, onPersisted);

    expect(result.error).toContain("relayer rejected c");
    expect(result.persisted.map((p) => p.item.idempotencyKey)).toEqual(["claim:a", "claim:b"]);
    expect(writeOne).toHaveBeenCalledTimes(3);
    expect(onPersisted).toHaveBeenCalledTimes(2);
    expect(order).toEqual([
      "write:claim:a",
      "record:claim:a",
      "write:claim:b",
      "record:claim:b",
      "write:claim:c",
    ]);
  });

  it("stops when the blob id cannot be recorded, so the next item is not sent", async () => {
    const writeOne = vi.fn(async (item: { idempotencyKey: string }) => ({
      blobId: `blob-${item.idempotencyKey}`,
    }));
    const onPersisted = vi.fn(async (item: { idempotencyKey: string }) => {
      if (item.idempotencyKey === "claim:a") throw new Error("database down");
    });

    const result = await writeDurable(
      [{ idempotencyKey: "claim:a" }, { idempotencyKey: "claim:b" }],
      writeOne,
      onPersisted,
    );

    expect(result.persisted).toHaveLength(0);
    expect(result.error).toContain("blob-claim:a");
    expect(result.error).toContain("database down");
    expect(writeOne).toHaveBeenCalledTimes(1);
  });
});
