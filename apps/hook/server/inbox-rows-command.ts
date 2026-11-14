/**
 * `plannotator inbox rows …` (approval "inbox-rows-settings-page"): a person asks an agent to change how the rows of
 * their Inbox list look, and the agent lists the options, sets some, and can undo the last change. A command and not
 * a tool, as `inbox projects` is: tool text costs every session tokens, and this runs seldom.
 *
 * A thin client over the route the window uses on this computer's listener (`GET` and `POST /api/inbox/settings`
 * `rows`, `rows_by`, `rows_undo`). It can reach row options only: it sends no other setting. Every word it prints is
 * core's (`@plannotator/core/inbox-types`), the one place the owner's words live.
 *
 * stdout: a text answer, or JSON with --json. A refusal goes to stderr as `<code>: <message>` and exits 1; bad usage
 * exits 2.
 */

import { INBOX_ROWS_DEFAULT, inboxRowsRead, type InboxRowsOption } from "@plannotator/core/inbox-types";
import { INBOX_ROWS_USAGE, INBOX_ROWS_WORDS, inboxRowsApply, inboxRowsChangeLines, inboxRowsListing, inboxRowsListingJson, type InboxRowsBy } from "@plannotator/core/inbox-types";
import type { InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import { hasHelpFlag } from "./cli";
import { writeWholeToStdout } from "./write-whole-stdout";

/** One request never waits longer: a wedged Inbox must not hang the agent. */
const REQUEST_TIMEOUT_MS = 30_000;

export type ParsedRowsCommand = { ok: true; op: "list" } | { ok: true; op: "set"; pairs: string[] } | { ok: true; op: "undo" } | { ok: false; error: string };

export function parseRowsCommand(argv: readonly string[]): ParsedRowsCommand {
  const [op, ...rest] = argv;
  if (op === undefined) return { ok: true, op: "list" };
  if (op === "undo") return rest.length > 0 ? { ok: false, error: "inbox rows undo takes nothing." } : { ok: true, op };
  if (op !== "set") return { ok: false, error: `Unknown inbox rows command: ${op}` };
  if (rest.length === 0) return { ok: false, error: INBOX_ROWS_WORDS.setNeedsPairs };
  return { ok: true, op, pairs: rest };
}

export interface RowsCommandDeps {
  json: boolean;
  ensureRunning: () => Promise<InboxRegistryEntry>;
  /** The agent session this shell runs in, when it names one: sent with a change, so the window says who made it. */
  by?: InboxRowsBy | null;
  out?: (text: string) => void | Promise<void>;
  err?: (text: string) => void;
  timeoutMs?: number;
}

/** Run `plannotator inbox rows …`; resolves to the exit code. */
export async function runInboxRowsCommand(argv: readonly string[], deps: RowsCommandDeps): Promise<number> {
  const out = deps.out ?? writeWholeToStdout;
  const err = deps.err ?? ((text: string) => void process.stderr.write(text));
  if (hasHelpFlag([...argv])) {
    await out(`${INBOX_ROWS_USAGE}\n`);
    return 0;
  }
  const parsed = parseRowsCommand(argv);
  if (!parsed.ok) {
    err(`${parsed.error}\n${INBOX_ROWS_USAGE}\n`);
    return 2;
  }
  const refused = (code: string, message: string) => {
    err(`${code}: ${message}\n`);
    return 1;
  };
  let entry: InboxRegistryEntry;
  try {
    entry = await deps.ensureRunning();
  } catch (error) {
    err(`Plannotator Inbox is not running: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const request = async (post?: Record<string, unknown>) => {
    const signal = AbortSignal.timeout(deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const response = await fetch(`http://127.0.0.1:${entry.port}/api/inbox/settings`, post ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(post), signal } : { signal });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: response.status, body };
  };
  /** The look as the windows read it: never saved is the defaults. */
  const lookOf = (body: Record<string, unknown> | null): InboxRowsOption[] => inboxRowsRead(body?.rows) ?? [...INBOX_ROWS_DEFAULT];
  const failed = (answer: { status: number; body: Record<string, unknown> | null }) => refused(typeof answer.body?.code === "string" ? answer.body.code : "error", typeof answer.body?.error === "string" ? answer.body.error : `The Inbox answered ${answer.status}. Nothing changed.`);
  try {
    const read = await request();
    if (read.status !== 200 || !read.body) return refused("error", "Plannotator Inbox did not answer with its settings.");
    const before = lookOf(read.body);
    if (parsed.op === "list") {
      await out(deps.json ? `${JSON.stringify(inboxRowsListingJson(before), null, 2)}\n` : inboxRowsListing(before));
      return 0;
    }
    const by = deps.by ? { rows_by: deps.by } : {};
    if (parsed.op === "undo") {
      const undone = await request({ rows_undo: true, ...by });
      if (undone.status !== 200) return failed(undone);
      const changed = undone.body?.rows_undone === true ? inboxRowsChangeLines(before, lookOf(undone.body)) : [];
      await out(deps.json ? `${JSON.stringify({ undone: changed.length > 0, changed, rows: lookOf(undone.body) }, null, 2)}\n` : changed.length > 0 ? `${[INBOX_ROWS_WORDS.undoneHead, ...changed.map((line) => `  ${line}`)].join("\n")}\n` : `${INBOX_ROWS_WORDS.nothingToUndo}\n`);
      return 0;
    }
    const applied = inboxRowsApply(before, parsed.pairs);
    if ("error" in applied) return refused("validation_error", applied.error);
    const changed = inboxRowsChangeLines(before, applied.rows);
    if (applied.rows.join() === before.join()) {
      await out(deps.json ? `${JSON.stringify({ changed: [], rows: before }, null, 2)}\n` : `${INBOX_ROWS_WORDS.nothingChanged}\n`);
      return 0;
    }
    const saved = await request({ rows: applied.rows, ...by });
    if (saved.status !== 200) return failed(saved);
    await out(deps.json ? `${JSON.stringify({ changed, rows: lookOf(saved.body) }, null, 2)}\n` : `${[INBOX_ROWS_WORDS.changedHead, ...changed.map((line) => `  ${line}`), INBOX_ROWS_WORDS.changedFoot].join("\n")}\n`);
    return 0;
  } catch (error) {
    return refused("error", `${error instanceof Error ? error.message : String(error)}. Nothing changed.`);
  }
}
