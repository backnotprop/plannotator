/**
 * Cross-process serialization for the managed Call flow runtime store.
 *
 * Review servers are independent processes but publish into one data-dir
 * runtime. The in-process coordinator cannot prevent their verified candidates
 * from swapping over each other, so every core/pack install holds this lease
 * through validation and atomic publication.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getPlannotatorDataDir } from "./data-dir";

const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1_000;
const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

export interface CallFlowInstallLockOptions {
  /** Test seam; production always uses the shared Plannotator data dir. */
  readonly lockPath?: string;
  readonly staleAfterMs?: number;
  readonly waitTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
}

function removeOwnedLock(lockPath: string, token: string): void {
  try {
    if (readFileSync(lockPath, "utf8") === token) rmSync(lockPath, { force: true });
  } catch {
    // A crashed or stale-recovery peer may already have removed the lease.
  }
}

/** Run one install while holding the shared, stale-tolerant runtime lease. */
export async function withCallFlowInstallLock<T>(
  work: () => Promise<T>,
  options: CallFlowInstallLockOptions = {},
): Promise<T> {
  const lockPath = options.lockPath
    ?? join(getPlannotatorDataDir(), "vendor", "call-flow", ".install.lock");
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = now() + waitTimeoutMs;

  mkdirSync(dirname(lockPath), { recursive: true });
  while (true) {
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(descriptor, token, "utf8");
      } finally {
        closeSync(descriptor);
      }
      break;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;

      try {
        if (now() - statSync(lockPath).mtimeMs > staleAfterMs) {
          rmSync(lockPath);
          continue;
        }
      } catch (statError) {
        if (hasErrorCode(statError, "ENOENT")) continue;
        throw statError;
      }

      if (now() >= deadline) {
        throw new Error("Timed out waiting for another Call flow runtime install to finish.");
      }
      await sleep(pollIntervalMs);
    }
  }

  try {
    return await work();
  } finally {
    removeOwnedLock(lockPath, token);
  }
}
