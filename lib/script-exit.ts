/**
 * Exit a one-off script once its work is done.
 *
 * postgres.js keeps its pool sockets referenced, and the default idle timeout
 * is off (`idle_timeout: null`). A script that queried and then returned
 * stays alive until `max_lifetime` (30–60 minutes) or until something kills
 * it. `sql.end()` drops those sockets. Other clients (a Sui `fetch`, an
 * aborted remember) can leave a referenced handle too, so after the close
 * callbacks this waits a short grace period and then exits anyway.
 */

/** How long a leftover handle may keep the process alive before we exit. */
export const SCRIPT_GRACE_MS = 1_000;

const STDIO_RESOURCES = new Set(["PipeWrap", "TTYWrap"]);

/**
 * Resource names that are still holding the event loop.
 *
 * `ignoreTimeouts` drops that many `Timeout` entries. The exit poll is itself
 * a timer, and it must not count as a reason to stay up.
 */
export function lingeringResources(resources: readonly string[], ignoreTimeouts = 0): string[] {
  const open: string[] = [];
  let skippedTimeouts = 0;
  for (const name of resources) {
    if (STDIO_RESOURCES.has(name)) continue;
    if (name === "Timeout" && skippedTimeouts < ignoreTimeouts) {
      skippedTimeouts += 1;
      continue;
    }
    open.push(name);
  }
  return open;
}

interface ActiveHandle {
  constructor?: { name?: string };
  fd?: number;
  localPort?: number;
  remotePort?: number;
  remoteAddress?: string;
  address?: () => unknown;
}

function liveHandles(): ActiveHandle[] {
  const getter = (process as NodeJS.Process & { _getActiveHandles?: () => ActiveHandle[] })._getActiveHandles;
  return getter ? getter.call(process) : [];
}

/** Names from `getActiveResourcesInfo`, plus socket endpoints when we can see them. */
export function describeOpenHandles(ignoreTimeouts = 0): string[] {
  const names = lingeringResources(process.getActiveResourcesInfo(), ignoreTimeouts);
  if (names.length === 0) return [];

  const where: string[] = [];
  for (const handle of liveHandles()) {
    const kind = handle.constructor?.name;
    if (kind === "Server") {
      const addr = handle.address?.();
      const port = addr && typeof addr === "object" && "port" in addr ? addr.port : undefined;
      where.push(typeof port === "number" ? `Server port ${port}` : "Server");
      continue;
    }
    if (kind !== "Socket" && kind !== "TLSSocket") continue;
    if (typeof handle.fd === "number" && handle.fd <= 2) continue;
    const local = handle.localPort ? `local ${handle.localPort}` : "";
    const remote = handle.remotePort ? `remote ${handle.remoteAddress ?? ""}:${handle.remotePort}` : "";
    const bits = [local, remote].filter(Boolean).join(" ");
    where.push(bits ? `${kind} ${bits}` : kind);
  }

  return where.length > 0 ? [...names, ...where] : names;
}

/**
 * Leave the process with `code`.
 *
 * If the only remaining handles are stdio, exit on the next check. If a
 * socket or timer is still referenced when `graceMs` elapses, log it and
 * exit with the same code. The timer is referenced on purpose: an unref'd
 * timer would not fire while the leftover socket is what is keeping us up.
 */
export function armScriptExit(code: number, opts?: { graceMs?: number }): void {
  const graceMs = opts?.graceMs ?? SCRIPT_GRACE_MS;
  const started = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;

  const tick = (ignoreTimeouts: number) => {
    const open = describeOpenHandles(ignoreTimeouts);
    if (open.length === 0) {
      if (timer) clearInterval(timer);
      process.exit(code);
    }
    if (Date.now() - started >= graceMs) {
      if (timer) clearInterval(timer);
      console.error(`exiting ${code}; still open after ${graceMs}ms:`);
      for (const line of open) console.error(`  ${line}`);
      process.exit(code);
    }
  };

  tick(0);
  timer = setInterval(() => tick(1), 50);
}

/**
 * Close what the script opened, then arm the exit.
 *
 * A close failure is printed and turns a success into exit 1. The process
 * still exits: a pool that refused to end is the hang we are here to stop.
 */
export async function finishScript(
  code: number,
  opts?: { graceMs?: number; close?: () => Promise<void> },
): Promise<void> {
  let exitCode = code;
  if (opts?.close) {
    try {
      await opts.close();
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      if (exitCode === 0) exitCode = 1;
    }
  }
  armScriptExit(exitCode, { graceMs: opts?.graceMs });
}
