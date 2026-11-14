/**
 * With the Inbox's debug log on (`resolveInboxDebug`), every process that starts or waits for an Inbox writes one
 * line to `inbox/inbox.log` per step of its start, then one as it exits. A process still alive whose last line is not
 * `serving` names what it waits for. A line holds pids, a port, an exit code and the fixed words below: nothing else.
 *
 * Not `debug.log`: the serving Inbox writes that file at offsets it keeps itself, so another process's lines there
 * would be overwritten. `inbox.log` is opened for appending by every writer.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "@plannotator/shared/config";
import { resolveInboxDebug } from "@plannotator/shared/inbox/debug-log";
import { inboxDir } from "@plannotator/shared/inbox/schema";

/** `detached`: an `inbox --no-open` a starter spawned. `direct`: a person's `plannotator inbox`. `starter`: anything that may spawn one. */
export type InboxStartRole = "detached" | "direct" | "starter";

export type InboxStartStep =
  | "lock_joined"
  | "lock_taken"
  | "lock_wait"
  | "busy_wait"
  | "already_running"
  | "spawned"
  | "serving"
  | "restart";

export interface InboxStartTrace {
  /** `inbox`: the pid of the Inbox already there. `child`: the pid this process spawned. */
  step(step: InboxStartStep, fields?: { inbox?: number; port?: number; child?: number }): void;
}

const OFF: InboxStartTrace = { step: () => {} };
const traces = new Map<string, InboxStartTrace>();

/**
 * This process's trace for `dataDir`; the first call decides its role and whether it is on. Off, it writes nothing.
 * On, a process that wrote a step also writes `exit` with its code as it ends; one that found the Inbox running and
 * wrote no step writes nothing.
 */
export function inboxStartTrace(dataDir: string, role: InboxStartRole, env: Record<string, string | undefined> = process.env): InboxStartTrace {
  const known = traces.get(dataDir);
  if (known) return known;
  if (!resolveInboxDebug(loadConfig({ quiet: true }), env)) {
    traces.set(dataDir, OFF);
    return OFF;
  }
  const dir = inboxDir(dataDir);
  const write = (record: Record<string, unknown>) => {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      appendFileSync(join(dir, "inbox.log"), `${JSON.stringify({ t: Date.now(), ev: "inbox_start", ...record, pid: process.pid, ppid: process.ppid, role })}\n`, { mode: 0o600 });
    } catch {
      // The trace never gets in a start's way.
    }
  };
  let exitHooked = false;
  const trace: InboxStartTrace = {
    step: (step, fields = {}) => {
      if (!exitHooked) {
        exitHooked = true;
        process.on("exit", (code) => write({ step: "exit", code }));
      }
      write({ ...fields, step });
    },
  };
  traces.set(dataDir, trace);
  return trace;
}
