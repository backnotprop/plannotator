/**
 * `plannotator inbox call <action> [<json> | -]` (approval
 * "inbox-scripting-command"): the Inbox tool from a script, so an agent can
 * one-shot a whole tidy instead of one tool call, and one result in its
 * context, per fix.
 *
 * A thin client: one `tools/call` to the running Inbox's `/mcp`, filled by the
 * stdio shim's own `fillInboxToolArguments`, starting a stopped Inbox detached
 * as `plannotator inbox mcp` does. No send, read or card logic lives here, and
 * `/mcp` keeps its boundary: this computer only, never a browser.
 *
 * Who is calling (`inboxCallerOf`) matters: "your cards", a Tidy counting a
 * session as tidied, thread ownership and the reply wake all go by session.
 *  - `--session <host>:<id>`, the exact value a Tidy's wake gives its session.
 *    It works the same on every host, OpenCode and MCP-only agents included,
 *    which have no session in their shell.
 *  - Else the session the environment names (`inboxHostSessionFromEnv`: Claude
 *    Code's tag, Pi's and Codex's variables, Qwen's).
 *  - Else none, as a raw MCP client: not a fresh id per process, which would
 *    make every call a stranger with no threads or cards of its own.
 * The JSON cannot name a session. A script must never write as another agent
 * by accident, and an agent started from another agent's shell inherits that
 * agent's session: so a shell that names two sessions (or a session and a host
 * that names none) is refused until `--session` says which, and a `--session`
 * this shell contradicts is refused.
 *
 * stdout: the result as one JSON value, and nothing else, so anything on it is
 * a success (empty on failure: `jq` then finds nothing, where a JSON error
 * would read as a result with null fields). A failure goes to stderr as
 * `<code>: <message>`. Exit 0 ok, 1 refused or unreachable, 2 bad usage.
 */

import { resolve } from "node:path";
import { INBOX_HOST_NAMES, INBOX_QWEN_SESSION_ENV, inboxTidyMcpLine, parseInboxSessionRef, type InboxTidyMark } from "@plannotator/core/inbox-types";
import { INBOX_MAX_REQUEST_BYTES, inboxRequestTooLargeMessage, inboxToolCallParams, mcpAnswerOfResponse } from "@plannotator/shared/inbox/connection";
import type { InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import { hasHelpFlag, INBOX_CALL_ACTIONS, INBOX_CALL_USAGE } from "./cli";
import { fillInboxToolArguments, type InboxHostSession, INBOX_SESSION_HOST_NAMES, inboxHostSessionFromEnv } from "./inbox-mcp-shim";

/** One request never waits longer: a wedged Inbox must not hang a script. */
const REQUEST_TIMEOUT_MS = 90_000;

/** The tool fields that say who is calling: only `--session` and the environment do. */
const IDENTITY_FIELDS = ["agent_session", "agent_host", "agent_name"] as const;

/** Each variable that names a host session, read on its own by the shim's own rule. */
const SESSION_VARIABLES = ["PLANNOTATOR_SESSION_TAG", "PI_SESSION_ID", "CODEX_THREAD_ID", INBOX_QWEN_SESSION_ENV] as const;

/** The hosts that mark the shells they start and name no session there (`detectOrigin`), with their host id when they have one. */
const SESSIONLESS_HOSTS: readonly { variable: string; name: string; host?: string }[] = [
  { variable: "OPENCODE", name: "OpenCode", host: "opencode" },
  { variable: "GEMINI_CLI", name: "Gemini CLI" },
  { variable: "COPILOT_CLI", name: "Copilot CLI" },
  { variable: "CURSOR_AGENT", name: "Cursor" },
  { variable: "DSH_SHELL", name: "DeepSeek Harness" },
];

export type InboxCaller = Pick<InboxHostSession, "session"> & Partial<InboxHostSession>;

/** The caller, or a refusal: `usage` exits 2. */
export type InboxCallerAnswer = { ok: true; caller: InboxCaller | null } | { ok: false; code: string; message: string; usage?: boolean };

const refOf = (caller: InboxCaller): string => (caller.host ? `${caller.host}:${caller.session}` : caller.session);

/** A `--session` value as a caller, by the rules of the tag it looks like. Null when it is malformed. */
function callerOfFlag(value: string): InboxCaller | null {
  const ref = parseInboxSessionRef(value);
  if (!ref) return null;
  if (ref.host === null) return { session: ref.session };
  if (Object.hasOwn(INBOX_SESSION_HOST_NAMES, ref.host)) return inboxHostSessionFromEnv({ PLANNOTATOR_SESSION_TAG: value });
  const name = INBOX_HOST_NAMES[ref.host];
  return { session: ref.session, host: ref.host, ...(name ? { name } : {}) };
}

/** Who this call is: see the file comment. */
export function inboxCallerOf(flag: string | null, env: Record<string, string | undefined>): InboxCallerAnswer {
  const named: InboxHostSession[] = [];
  for (const variable of SESSION_VARIABLES) {
    const found = inboxHostSessionFromEnv({ [variable]: env[variable] });
    if (found && !named.some((other) => other.host === found.host && other.session === found.session)) named.push(found);
  }
  const sessionless = SESSIONLESS_HOSTS.filter(({ variable, host }) => env[variable] && !named.some((other) => other.host === host));
  if (flag !== null) {
    const caller = callerOfFlag(flag);
    if (!caller) return { ok: false, usage: true, code: "invalid_session", message: `--session takes <host>:<id> or <id>, as your Tidy's wake gives it, not ${JSON.stringify(flag)}.` };
    // A host that names no session, in this shell's line, may be who holds the flag; otherwise the shell knows better.
    if (named.length === 0 || sessionless.length > 0 || named.some((other) => other.host === caller.host && other.session === caller.session)) return { ok: true, caller };
    const shell = named.map(refOf).join(", ");
    return { ok: false, code: "session_mismatch", message: `--session ${flag} is not the session this shell runs in (${shell}). Nothing was sent. Leave --session out to write as ${named.length === 1 ? "it" : "one of those"}.` };
  }
  if (named.length + sessionless.length > 1 && named.length > 0) {
    const seen = [...named.map(refOf), ...sessionless.map(({ name }) => `${name}, which names no session`)].join("; ");
    return { ok: false, code: "session_ambiguous", message: `This shell was started inside another agent: it carries ${seen}. Nothing was sent. Pass --session with your own session, so you never write as the other agent.` };
  }
  return { ok: true, caller: named[0] ?? null };
}

export type ParsedCallCommand =
  | { ok: true; action: string; json: string | null; stdin: boolean; session: string | null }
  | { ok: false; code: string; error: string };

export function parseCallCommand(argv: readonly string[]): ParsedCallCommand {
  const positional: string[] = [];
  let session: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--session") {
      const value = argv[++i];
      if (value === undefined) return { ok: false, code: "invalid_session", error: "--session takes a value." };
      if (session !== null) return { ok: false, code: "invalid_session", error: "--session given twice." };
      session = value;
    } else if (arg.startsWith("--")) return { ok: false, code: "usage", error: `Unknown inbox call option: ${arg}` };
    else positional.push(arg);
  }
  const [action, json, ...more] = positional;
  if (action === undefined) return { ok: false, code: "usage", error: "inbox call needs an action." };
  if (!(INBOX_CALL_ACTIONS as readonly string[]).includes(action)) return { ok: false, code: "unknown_action", error: `${action} is not an Inbox action. Actions: ${INBOX_CALL_ACTIONS.join(", ")}.` };
  if (more.length > 0) return { ok: false, code: "usage", error: "inbox call takes one JSON argument (quote it), or - to read it from stdin." };
  return { ok: true, action, json: json === "-" ? null : (json ?? null), stdin: json === "-", session };
}

/** The tool's arguments from the JSON text, or why they are not. PowerShell's pipe may start with a BOM. */
function argumentsOf(text: string, cwd: string): { args: Record<string, unknown> } | { code: string; error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    return { code: "invalid_json", error: `The arguments are not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { code: "invalid_json", error: "The arguments must be one JSON object." };
  const args = value as Record<string, unknown>;
  const identity = IDENTITY_FIELDS.find((field) => field in args);
  if (identity) return { code: "invalid_arguments", error: `${identity}: not taken here. --session and this shell say who is calling.` };
  // The Inbox resolves a path in its own folder: a relative one means this one, as on the agent tool.
  if (typeof args.project_path === "string") args.project_path = resolve(cwd, args.project_path);
  return { args };
}

export interface CallCommandDeps {
  cwd: string;
  env: Record<string, string | undefined>;
  ensureRunning: () => Promise<InboxRegistryEntry>;
  /** Inside an agent Plannotator's Ask AI started (`isAskAiChild`): the Inbox is off there, as in the shim. */
  askAiChild?: boolean;
  /** Default: this process's stdin. */
  stdin?: () => Promise<string>;
  /** Default: stdout, waited for, so a long result reaches a pipe whole before the process exits. */
  out?: (text: string) => void | Promise<void>;
  err?: (text: string) => void;
  /** Tests: how long one request may take. */
  timeoutMs?: number;
}

/** Run `plannotator inbox call …`; resolves to the exit code. */
export async function runInboxCallCommand(argv: readonly string[], deps: CallCommandDeps): Promise<number> {
  const out = deps.out ?? ((text: string) => new Promise<void>((done) => void process.stdout.write(text, () => done())));
  const err = deps.err ?? ((text: string) => void process.stderr.write(text));
  const refused = (code: string, message: string, exit = 1) => {
    err(`${code}: ${message}\n`);
    return exit;
  };
  if (hasHelpFlag([...argv])) {
    await out(`${INBOX_CALL_USAGE}\n`);
    return 0;
  }
  const parsed = parseCallCommand(argv);
  if (!parsed.ok) {
    err(`${parsed.code}: ${parsed.error}\n${INBOX_CALL_USAGE}\n`);
    return 2;
  }
  if (deps.askAiChild) return refused("inbox_off", "The Plannotator Inbox is off in an agent that Plannotator's Ask AI started.");
  const caller = inboxCallerOf(parsed.session, deps.env);
  if (!caller.ok) return refused(caller.code, caller.message, caller.usage ? 2 : 1);
  const text = parsed.stdin ? await (deps.stdin ?? (() => Bun.stdin.text()))() : (parsed.json ?? "{}");
  const input = argumentsOf(text, deps.cwd);
  if ("error" in input) return refused(input.code, input.error, 2);

  const call = fillInboxToolArguments({ method: "tools/call", params: { name: parsed.action, arguments: input.args } }, deps.cwd, null, caller.caller);
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    // Where the script runs is where its relative attachments and images are, wherever its project is.
    params: inboxToolCallParams({ name: parsed.action, arguments: call.params!.arguments as Record<string, unknown> }, { wakes: false, workingFolder: deps.cwd }),
  });
  const bytes = Buffer.byteLength(body);
  if (bytes > INBOX_MAX_REQUEST_BYTES) return refused("request_too_large", inboxRequestTooLargeMessage(bytes));

  let entry: InboxRegistryEntry;
  try {
    entry = await deps.ensureRunning();
  } catch (error) {
    return refused("inbox_not_running", `Plannotator Inbox is not running: ${error instanceof Error ? error.message : String(error)}`);
  }
  let answer: ReturnType<typeof mcpAnswerOfResponse>;
  try {
    const response = await fetch(`http://127.0.0.1:${entry.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body,
      signal: AbortSignal.timeout(deps.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    answer = mcpAnswerOfResponse(response.status, await response.text());
  } catch (error) {
    return refused("inbox_no_answer", `Plannotator Inbox did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!answer) return refused("inbox_no_answer", "Plannotator Inbox gave no answer.");
  if (answer.error) return refused("inbox_error", answer.error.message ?? "The Inbox refused the call.");
  const result = answer.result as { content?: { text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean } | undefined;
  const words = (result?.content ?? []).map((part) => part.text ?? "").join("\n");
  if (result?.isError) {
    // The Inbox's refusals are `<code>: <message>`; the MCP layer's (a field the schema does not take) are plain words.
    err(`${/^[a-z][a-z0-9_]*: /.test(words) ? words : `invalid_arguments: ${words || "The call was refused."}`}\n`);
    return 1;
  }
  // A Tidy that waited for this session's next call rides this result: a script keeps only what it prints, so the agent reads it here.
  const tidy = result?.structuredContent?.tidy as (Pick<InboxTidyMark, "id"> & { text: string }) | undefined;
  if (tidy) err(`${inboxTidyMcpLine(tidy.id)}\n\n${tidy.text}\n`);
  await out(`${JSON.stringify(result?.structuredContent ?? { text: words })}\n`);
  return 0;
}
