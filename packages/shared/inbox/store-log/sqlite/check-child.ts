/// <reference types="bun-types" />
/**
 * Half of the import's check, in a second process (`import.ts`): the files' side of the check and the new database's
 * `integrity_check` run there while the import writes and checks the database here, so a move takes about the time of
 * its write and the database's side, not of every step one after another. Same rules as one process: the files read
 * by today's JSONL reader into a store of their own (`check.ts` `digestOf`), and SQLite's own integrity check.
 *
 * The second process is this program again (`command`: the CLI the Inbox runs as, `selfCommand()`), told what to do
 * by `INBOX_CHECK_CHILD_ENV`; it starts reading the files at once. Lines on its stdout, one JSON value each: the
 * files' digest, then the answer to each `integrity <file>` line sent to its stdin. It ends when its stdin closes,
 * so a move killed half way never leaves it behind. A second process that cannot start or fails: the import does
 * that half itself, as before.
 */
import { jsonlInboxLog } from "../jsonl-log";
import { digestOf, integrityOf } from "./check";
import type { InboxStoreDigest } from "./digest";

/** Set (to the data dir) in the second process's env: what makes the program run `runInboxCheckChild`. */
export const INBOX_CHECK_CHILD_ENV = "PLANNOTATOR_INBOX_CHECK_FILES";
/** The time both sides read the store at (ISO). */
const NOW_ENV = "PLANNOTATOR_INBOX_CHECK_NOW";

/** The files' digest from the data dir's JSONL files, read now (both processes read them by this one function). */
export function filesDigest(dataDir: string, now: () => Date): InboxStoreDigest {
  return digestOf(dataDir, now, { log: jsonlInboxLog });
}

/** The second process's side: answer on stdout until stdin closes. Returns the exit code. */
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
  /** The files' digest, as soon as the second process has it. */
  digest(): Promise<InboxStoreDigest>;
  /**
   * Ask for `integrity_check` of `file`, run there: resolves once the request has left (so this thread can block on
   * its own work meanwhile) with the answer still to come.
   */
  integrity(file: string): Promise<{ answer: Promise<string> }>;
  /** Done with it: its stdin closes and it ends (killed if it does not). */
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
      windowsHide: true,
    });
  } catch {
    return null;
  }
  // Each stdout line, in order, to whoever waits next.
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
      // Ends below, as a process that stopped answering.
    }
    ended = new Error(`the check's second process ended (exit ${await child.exited})`);
    for (const waiter of waiting.splice(0)) waiter.reject(ended);
  })();
  const digest = next().then((value) => value.digest as InboxStoreDigest);
  return {
    digest: () => digest,
    integrity: async (file) => {
      // The request is written out before this returns: a write still queued would wait for this thread to be free.
      child.stdin.write(`integrity ${file}\n`);
      await child.stdin.flush();
      // The digest comes first on stdout; the answer is the line after it.
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
