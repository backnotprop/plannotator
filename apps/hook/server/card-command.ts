/**
 * `plannotator card …`: the Board's card call from a shell (approval
 * "inbox-board", step 1), for an agent or a lane that logs from the shell.
 * A thin client over the Inbox's `card` MCP tool (packages/server/inbox-mcp-cards.ts):
 * one `tools/call` to the running Inbox's `/mcp`, started detached when it is
 * stopped, exactly as `plannotator inbox mcp` reaches it. The rules live once,
 * in the server.
 *
 * Unreleased: `card` is in HIDDEN_SUBCOMMANDS (cli.ts), so it stays out of
 * `plannotator --help` and the plannotator skill until the Board ships.
 *
 * The session: inside an agent host session (a Claude Code session's
 * `PLANNOTATOR_SESSION_TAG`, a Pi bash call's `PI_SESSION_ID`) the card is
 * that session's, as its `plannotator_inbox` tool would make it; otherwise it
 * is nobody's in particular, and `list` lists every card in the project.
 *
 * stdout: the tool's text (or its structured result with --json). A refusal
 * goes to stderr as `<code>: <message>` and exits 1; bad usage exits 2.
 */

import { resolve } from "node:path";
import { mcpAnswerOf } from "@plannotator/shared/inbox/connection";
import type { InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import { CARD_COMMAND_USAGE } from "./cli";
import { inboxHostSessionFromEnv } from "./inbox-mcp-shim";

export { CARD_COMMAND_USAGE };

type Op = "create" | "move" | "say" | "link" | "ship" | "drop" | "list";

/** A parsed command: the tool's arguments (without the filled ones), or why it is not one. */
export type ParsedCardCommand =
  | { ok: true; op: Op; args: Record<string, unknown>; project: string | null; json: boolean }
  | { ok: false; error: string };

const VALUE_FLAGS: Record<string, string> = {
  "--column": "column",
  "--say": "say",
  "--you": "you",
  "--thread": "thread_id",
  "--pr": "pr",
  "--ref": "ref",
  "--key": "idempotency_key",
  "--reason": "reason",
  "--title": "title",
  "--project": "project",
};

/** The positional arguments each command takes, by the tool field they fill. */
const POSITIONAL: Record<Op, { names: readonly string[]; required: number }> = {
  create: { names: ["title"], required: 0 },
  move: { names: ["card_id", "column"], required: 2 },
  say: { names: ["card_id", "say"], required: 1 },
  link: { names: ["card_id"], required: 1 },
  ship: { names: ["card_id"], required: 1 },
  drop: { names: ["card_id", "reason"], required: 2 },
  list: { names: [], required: 0 },
};

export function parseCardCommand(argv: readonly string[]): ParsedCardCommand {
  const op = argv[0] as Op | undefined;
  if (!op || !Object.hasOwn(POSITIONAL, op)) return { ok: false, error: op ? `Unknown card command: ${op}` : "A card command: create, move, say, link, ship, drop or list." };
  const args: Record<string, unknown> = { op };
  const positional: string[] = [];
  let project: string | null = null;
  let json = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") json = true;
    else if (arg === "--all" && op === "list") args.include_resolved = true;
    else if (arg === "--anyone" && op === "list") args.asked_by = "anyone";
    else if (arg === "--mine" && op === "list") args.asked_by = "me";
    else if (Object.hasOwn(VALUE_FLAGS, arg)) {
      const value = argv[i + 1];
      if (value === undefined) return { ok: false, error: `${arg} takes a value.` };
      i++;
      const field = VALUE_FLAGS[arg]!;
      if (field === "project") project = value;
      else if (field in args) return { ok: false, error: `${arg} given twice.` };
      else args[field] = value;
    } else if (arg.startsWith("--")) return { ok: false, error: `Unknown card option: ${arg}` };
    else positional.push(arg);
  }
  const { names, required } = POSITIONAL[op];
  if (positional.length > names.length) {
    return { ok: false, error: `card ${op} takes ${names.length === 0 ? "no words" : `at most: ${names.join(", ")}`} (quote a title or line with spaces).` };
  }
  if (positional.length < required) return { ok: false, error: `card ${op} needs: ${names.slice(0, required).join(", ")}.` };
  for (const [index, value] of positional.entries()) {
    const field = names[index]!;
    if (field in args) return { ok: false, error: `${field} given twice.` };
    args[field] = value;
  }
  if (op === "create" && args.title === undefined && args.thread_id === undefined) return { ok: false, error: "card create needs a title, or --thread <id>." };
  return { ok: true, op, args, project, json };
}

export interface CardCommandDeps {
  cwd: string;
  env: Record<string, string | undefined>;
  ensureRunning: () => Promise<InboxRegistryEntry>;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

/** Run `plannotator card …`; resolves to the exit code. */
export async function runCardCommand(argv: readonly string[], deps: CardCommandDeps): Promise<number> {
  const out = deps.out ?? ((text: string) => void process.stdout.write(text));
  const err = deps.err ?? ((text: string) => void process.stderr.write(text));
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    (argv.length === 0 ? err : out)(`${CARD_COMMAND_USAGE}\n`);
    return argv.length === 0 ? 2 : 0;
  }
  const parsed = parseCardCommand(argv);
  if (!parsed.ok) {
    err(`${parsed.error}\n${CARD_COMMAND_USAGE}\n`);
    return 2;
  }
  const args: Record<string, unknown> = { ...parsed.args, project_path: resolve(deps.cwd, parsed.project ?? ".") };
  // Inside an agent host session the card is that session's, as its plannotator_inbox tool would make it.
  const host = inboxHostSessionFromEnv(deps.env);
  if (host) {
    args.agent_session = host.session;
    args.agent_host = host.host;
    args.agent_name = host.name;
  }
  let entry: InboxRegistryEntry;
  try {
    entry = await deps.ensureRunning();
  } catch (error) {
    err(`Plannotator Inbox is not running: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  let text: string;
  try {
    const response = await fetch(`http://127.0.0.1:${entry.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "card", arguments: args } }),
    });
    text = await response.text();
  } catch (error) {
    err(`Plannotator Inbox did not answer: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const answer = mcpAnswerOf(text);
  // The card action held back (INBOX_CARD_ACTION_ON), or an Inbox older than the Board: no card tool.
  const noCards = (text: string) => /tool card not found|unknown tool/i.test(text);
  if (!answer || answer.error) {
    const message = answer?.error?.message ?? "Plannotator Inbox gave no answer.";
    err(noCards(message) ? "This Plannotator Inbox does not offer cards yet.\n" : `${message}\n`);
    return 1;
  }
  const result = answer.result as { content?: { type?: string; text?: string }[]; structuredContent?: unknown; isError?: boolean } | undefined;
  const body = (result?.content ?? []).map((part) => part.text ?? "").join("\n");
  if (result?.isError) {
    err(`${body || "The card call was refused."}\n`);
    if (noCards(body)) err("This Plannotator Inbox does not offer cards yet.\n");
    return 1;
  }
  out(parsed.json ? `${JSON.stringify(result?.structuredContent ?? null, null, 2)}\n` : `${body}\n`);
  return 0;
}
