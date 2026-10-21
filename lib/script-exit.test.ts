import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lingeringResources } from "./script-exit";

const helper = pathToFileURL(path.resolve("lib/script-exit.ts")).href;

function runNode(source: string, waitMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      cwd: path.resolve("."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
    }, waitMs);
    child.on("error", (err) => {
      clearTimeout(killer);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, out });
    });
  });
}

describe("lingeringResources", () => {
  it("ignores stdio and the exit timer", () => {
    expect(lingeringResources(["PipeWrap", "TTYWrap", "Timeout"], 1)).toEqual([]);
  });

  it("keeps a socket and any timer that is not the exit poll", () => {
    expect(lingeringResources(["PipeWrap", "Timeout", "TCPSocketWrap", "Timeout"], 1)).toEqual([
      "TCPSocketWrap",
      "Timeout",
    ]);
  });
});

describe("armScriptExit", () => {
  it("exits immediately when nothing is holding the loop", async () => {
    const result = await runNode(`import { armScriptExit } from ${JSON.stringify(helper)}; armScriptExit(4, { graceMs: 5000 });`, 3_000);
    expect(result.signal).toBeNull();
    expect(result.code).toBe(4);
    expect(result.out).not.toContain("still open");
  });

  it("exits with the requested code and names a socket that is still open", async () => {
    const result = await runNode(
      `
      import net from "node:net";
      import { armScriptExit } from ${JSON.stringify(helper)};
      const server = net.createServer();
      server.listen(0, "127.0.0.1", () => armScriptExit(3, { graceMs: 200 }));
      `,
      5_000,
    );
    expect(result.signal).toBeNull();
    expect(result.code).toBe(3);
    expect(result.out).toContain("still open");
    expect(result.out).toContain("TCPServerWrap");
  });

  it("names the postgres socket when the pool is left open", async () => {
    const result = await runNode(
      `
      import net from "node:net";
      import postgres from "postgres";
      import { finishScript } from ${JSON.stringify(helper)};
      const server = net.createServer((socket) => { socket.on("error", () => {}); });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        const sql = postgres({ host: "127.0.0.1", port, database: "x", username: "x", max: 1, connect_timeout: 30 });
        sql\`select 1\`.catch(() => {});
        setTimeout(() => finishScript(0, { graceMs: 200 }), 50);
      });
      `,
      4_000,
    );
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.out).toContain("TCPSocketWrap");
  });

  it("exits cleanly once the pool has been ended", async () => {
    const result = await runNode(
      `
      import postgres from "postgres";
      import { finishScript } from ${JSON.stringify(helper)};
      const sql = postgres({ host: "127.0.0.1", port: 1, database: "x", username: "x", max: 1, connect_timeout: 1 });
      sql\`select 1\`.catch(() => {});
      await finishScript(0, { graceMs: 1_000, close: () => sql.end({ timeout: 1 }) });
      `,
      4_000,
    );
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.out).not.toContain("still open");
  });
});
