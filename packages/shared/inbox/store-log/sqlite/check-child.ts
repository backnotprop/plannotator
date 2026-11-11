/// <reference types="bun-types" />
/**
 * The files' side of the import's check and the `integrity_check`, run in a second process (this program again)
 * so they overlap the database's side. It ends when its stdin closes, so a killed move never leaves it behind.
 */
import { jsonlInboxLog } from "../jsonl-log";
import { digestOf, integrityOf } from "./check";
import type { InboxStoreDigest } from "./digest";

/** Set to the data dir in the second process's env. */
export const INBOX_CHECK_CHILD_ENV = "PLANNOTATOR_INBOX_CHECK_FILES";
const NOW_ENV = "PLANNOTATOR_INBOX_CHECK_NOW";

export function filesDigest(dataDir: string, now: () => Date): InboxStoreDigest {
  return digestOf(dataDir, now, { log: jsonlInboxLog });
}

/** Answers on stdout, one JSON value per line, until stdin closes. Returns the exit code. */
export async function runInboxCheckChild(env: Record<string, string | undefined>): Promise<number> {
  const dataDir = env[INBOX_CHECK_CHILD_ENV]!;
  const at = new Date(env[NOW_ENV] ?? Date.now());
  const say = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  say({ digest: filesDigest(dataDir, () => at) });
  let pending = "";
  for await (const chunk of Bun.stdin.stream()) {
    pending += new TextDecoder().decode(chunk);
    for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (line.startsWith("integrity ")) say({ integrity: integrityOf(line.slice("integrity ".length)) });
    }
  }
  return 0;
}

export interface FilesCheckProcess {
  digest(): Promise<InboxStoreDigest>;
  /** Resolves once the request has left, so this thread can block on its own work; the answer comes later. */
  integrity(file: string): Promise<{ answer: Promise<string> }>;
  close(): void;
}

/** Start the second process, or null when it cannot start (the caller then checks here). */
export function spawnFilesCheck(command: readonly string[], dataDir: string, now: Date): FilesCheckProcess | null {
  let child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "inherit">>;
  try {
    child = Bun.spawn([...command], {
      env: { ...process.env, [INBOX_CHECK_CHILD_ENV]: dataDir, [NOW_ENV]: now.toISOString() },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
  } catch {
    return null;
  }
  const waiting: { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }[] = [];
  const ready: Record<string, unknown>[] = [];
  let ended: Error | null = null;
  const next = () =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const value = ready.shift();
      if (value) resolve(value);
      else if (ended) reject(ended);
      else waiting.push({ resolve, reject });
    });
  void (async () => {
    let pending = "";
    try {
      for await (const chunk of child.stdout) {
        pending += new TextDecoder().decode(chunk);
        for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
          const value = JSON.parse(pending.slice(0, end)) as Record<string, unknown>;
          pending = pending.slice(end + 1);
          const waiter = waiting.shift();
          if (waiter) waiter.resolve(value);
          else ready.push(value);
        }
      }
    } catch {
      // Treated below as a process that stopped answering.
    }
    ended = new Error(`the check's second process ended (exit ${await child.exited})`);
    for (const waiter of waiting.splice(0)) waiter.reject(ended);
  })();
  const digest = next().then((value) => value.digest as InboxStoreDigest);
  return {
    digest: () => digest,
    integrity: async (file) => {
      // Flushed before returning: a queued write would wait for this thread, which is about to block.
      child.stdin.write(`integrity ${file}\n`);
      await child.stdin.flush();
      const answer = digest.then(() => next()).then((value) => String(value.integrity));
      answer.catch(() => {});
      return { answer };
    },
    close: () => {
      try {
        child.stdin.end();
      } catch {
        // Already closed.
      }
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 5_000).unref();
    },
  };
}
