/**
 * The board's Close and its Undo, kept (approval "inbox-pr-board-close-safe", "a log line per close and reopen"):
 * one line per close and per reopen in `<data dir>/inbox/pull-closes.jsonl`, always, debug log on or off, so a past
 * close can be confirmed later. The line is the debug log's `pull_close` fields (`pullCloseFields`: what, the PR's key,
 * how it ended, how the press came) stamped with `t` (ms). Never a title or anyone's name. A close is a rare,
 * deliberate press, so the file stays small; a write that fails costs the line, never the answer.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const PULL_CLOSES_FILE = "pull-closes.jsonl";

export function keepPullClose(inboxDir: string, fields: Record<string, unknown>, now = Date.now()): void {
  try {
    mkdirSync(inboxDir, { recursive: true, mode: 0o700 });
    appendFileSync(join(inboxDir, PULL_CLOSES_FILE), `${JSON.stringify({ t: now, ...fields })}\n`, { mode: 0o600 });
  } catch {
    // The close or reopen went (or was refused) all the same; its answer must not wait on, or fail for, this line.
  }
}
