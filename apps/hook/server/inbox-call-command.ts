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
 *    Code's tag, T3 Code's thread, Pi's and Codex's variables, Qwen's,
 *    DeepSeek Harness's). A T3 thread beside Claude's own CLAUDECODE is that
 *    thread: T3 runs Claude through the Agent SDK, where the mod and its tag
 *    are off. Beside anything else it is ambiguous, as below.
 *  - Else none, as a raw MCP client: not a fresh id per process, which would
 *    make every call a stranger with no threads or cards of its own.
 * The JSON cannot name a session. A script must never write as another agent
 * by accident, and an agent started from another agent's shell inherits that
 * agent's session: so a shell that names two sessions (or a session and a host
 * that names none) is refused until `--session` says which, and a `--session`
 * this shell contradicts is refused. That refusal never points at leaving the
 * flag out, which would write as the session the shell names: a shell older
 * than its agent's session names an id that agent no longer is, and its Tidy
 * would not count. A new shell, or one with that variable unset, writes rightly.
 *
 * A read of a thread or message with no session settles nothing (the peek
 * mark): nobody read it, so what the thread's owner still waits for stays queued.
 *
 * stdout: the result as one JSON value, and nothing else, so anything on it is
 * a success (empty on failure: `jq` then finds nothing, where a JSON error
 * would read as a result with null fields). A failure goes to stderr as
 * `<code>: <message>`. Exit 0 ok, 1 refused or unreachable, 2 bad usage.
 */

import { resolve } from "node:path";
import { INBOX_HOST_NAMES, INBOX_QWEN_SESSION_ENV, INBOX_T3_HOST, INBOX_T3_THREAD_ENV, inboxTidyMcpLine, parseInboxSessionRef, type InboxTidyMark } from "@plannotator/core/inbox-types";
import { INBOX_MAX_REQUEST_BYTES, INBOX_PEEK_META_KEY, inboxRequestTooLargeMessage, inboxToolCallParams, mcpAnswerOfResponse } from "@plannotator/shared/inbox/connection";
import type { InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import { attachedImagesNotInBodyText } from "@plannotator/shared/inbox/attached-images";
import { questionsToCheckText } from "@plannotator/shared/inbox/questions-to-check";
import type { InboxQuestionToCheck } from "@plannotator/core/inbox-questions";
import { questionOpenersWithTextText, type QuestionOpenerWithText } from "@plannotator/shared/inbox/question-openers";
import { hasHelpFlag, INBOX_CALL_ACTIONS, INBOX_CALL_USAGE } from "./cli";
import { writeWholeToStdout } from "./write-whole-stdout";
import { fillInboxToolArguments, type InboxHostSession, INBOX_DSH_ROOT_FOR_ENV, INBOX_DSH_ROOT_SESSION_ENV, INBOX_SESSION_HOST_NAMES, inboxHostSessionFromEnv, inboxSessionProjectFromEnv } from "./inbox-mcp-shim";

/** One request never waits longer: a wedged Inbox must not hang a script. */
const REQUEST_TIMEOUT_MS = 90_000;

/** The tool fields that say who is calling: only `--session` and the environment do. */
const IDENTITY_FIELDS = ["agent_session", "agent_host", "agent_name"] as const;

/** Each variable that names a host session, read on its own by the shim's own rule. */
const SESSION_VARIABLES = ["PLANNOTATOR_SESSION_TAG", INBOX_T3_THREAD_ENV, "PI_SESSION_ID", "CODEX_THREAD_ID", INBOX_QWEN_SESSION_ENV, "DSH_SESSION_ID"] as const;

/**
 * The hosts that mark the shells they start (`detectOrigin`), each here for a
 * shell where it names no session, with its host id when it has one. A marker
 * beside that same host's session is that host's own shell. Oh My Pi's sessions
 * are Pi's (the Pi extension), so its marker beside PI_SESSION_ID is one host too.
 */
const SESSIONLESS_HOSTS: readonly { variable: string; name: string; host?: string }[] = [
  { variable: "CLAUDECODE", name: "Claude Code", host: "claude-code" },
  { variable: "OMPCODE", name: "Oh My Pi", host: "pi" },
  { variable: "QWEN_CODE", name: "Qwen Code", host: "qwen" },
  { variable: "OPENCODE", name: "OpenCode", host: "opencode" },
  { variable: "GEMINI_CLI", name: "Gemini CLI" },
  { variable: "COPILOT_CLI", name: "Copilot CLI" },
  { variable: "CURSOR_AGENT", name: "Cursor" },
  { variable: "DSH_SHELL", name: "DeepSeek Harness", host: "dsh" },
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
  const variables: string[] = [];
  for (const variable of SESSION_VARIABLES) {
    // DSH_SESSION_ID names a session only in a DSH model shell (DSH_SHELL=1), where the plugin may name its parent.
    const slice = variable === "DSH_SESSION_ID" ? { DSH_SESSION_ID: env.DSH_SESSION_ID, DSH_SHELL: env.DSH_SHELL, [INBOX_DSH_ROOT_SESSION_ENV]: env[INBOX_DSH_ROOT_SESSION_ENV], [INBOX_DSH_ROOT_FOR_ENV]: env[INBOX_DSH_ROOT_FOR_ENV] } : { [variable]: env[variable] };
    const found = inboxHostSessionFromEnv(slice);
    if (!found) continue;
    // The variable the session came from: the plugin's root when it named it, so the advice to unset it is right.
    variables.push(variable === "DSH_SESSION_ID" && found.session !== env.DSH_SESSION_ID ? INBOX_DSH_ROOT_SESSION_ENV : variable);
    if (!named.some((other) => other.host === found.host && other.session === found.session)) named.push(found);
  }
  const sessionless = SESSIONLESS_HOSTS.filter(({ variable, host }) => env[variable] && !named.some((other) => other.host === host));
  if (flag !== null) {
    const caller = callerOfFlag(flag);
    if (!caller) return { ok: false, usage: true, code: "invalid_session", message: `--session takes <host>:<id> or <id>, as your Tidy's wake gives it, not ${JSON.stringify(flag)}.` };
    // A host that names no session, in this shell's line, may be who holds the flag; otherwise the shell knows better.
    if (named.length === 0 || sessionless.length > 0 || named.some((other) => other.host === caller.host && other.session === caller.session)) return { ok: true, caller };
    const shell = named.map(refOf).join(", ");
    const names = variables.join(" and ");
    return {
      ok: false,
      code: "session_mismatch",
      message: `--session ${flag} is not the session this shell names (${shell}, from ${names}). Nothing was sent. Do not drop --session to get past this: that writes as ${shell}. If the value is from your own Tidy, this shell is older than your session: run the script in a new shell, or unset ${names} for it. If it is not, it is not yours to use.`,
    };
  }
  // A T3 thread's Claude: the thread is the only session named and Claude's own CLAUDECODE the only marker. A Codex id,
  // a tag (from a Claude Code that started T3) or any other marker beside it stays ambiguous.
  const t3Claude = named.length === 1 && named[0]!.host === INBOX_T3_HOST && sessionless.length === 1 && sessionless[0]!.host === "claude-code";
  if (!t3Claude && named.length + sessionless.length > 1 && named.length > 0) {
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
    } else if (arg.startsWith("--")) return { ok: false, code: "usage", error: `Unknown inbox call option: ${arg}. A flag and its value are separate words: --session <id>.` };
    else positional.push(arg);
  }
  const [action, json, ...more] = positional;
  if (action === undefined) return { ok: false, code: "usage", error: "inbox call needs an action." };
  // `steps` is left out of the list, as in the usage: it is served only while the person has thread steps on (and the
  // switch is the Inbox's, not known here), so an agent with them off reads no word of it.
  if (!(INBOX_CALL_ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, code: "unknown_action", error: `${action} is not an Inbox action. Actions: ${INBOX_CALL_ACTIONS.filter((name) => name !== "steps").join(", ")}.` };
  }
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
  const out = deps.out ?? writeWholeToStdout;
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

  // With no project_path, the session's own project (its host's PLANNOTATOR_SESSION_PROJECT), wherever the shell has cd'd to.
  const call = fillInboxToolArguments({ method: "tools/call", params: { name: parsed.action, arguments: input.args } }, deps.cwd, null, caller.caller, null, inboxSessionProjectFromEnv(deps.env));
  // Where the script runs is where its relative attachments and images are, wherever its project is.
  const params = inboxToolCallParams({ name: parsed.action, arguments: call.params!.arguments as Record<string, unknown> }, { wakes: false, workingFolder: deps.cwd });
  // Only on a read of one thread or message: a list has nothing to settle, and the peek would empty it.
  if (caller.caller === null && (input.args.thread_id || input.args.message_id)) params._meta = { ...(params._meta as Record<string, unknown>), [INBOX_PEEK_META_KEY]: true };
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params });
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
  // A question line that opened no block (`:::question {#x}`): the result text's warning, one line each, on stderr so stdout stays one JSON value.
  const openers = result?.structuredContent?.question_openers_with_text;
  const moreOpeners = result?.structuredContent?.question_openers_with_text_more;
  if (Array.isArray(openers) && openers.length > 0) {
    try {
      err(`${questionOpenersWithTextText(openers as QuestionOpenerWithText[], typeof moreOpeners === "number" ? moreOpeners : 0).trim()}\n`);
    } catch {
      // A malformed list (never from this Inbox) prints no warning; the result below still does.
    }
  }
  // Pictures sent only as attachments: the result text's advice, on stderr too.
  const attachedOnly = result?.structuredContent?.attached_images_not_in_body;
  if (Array.isArray(attachedOnly) && attachedOnly.length > 0) err(`${attachedImagesNotInBodyText(attachedOnly.length).trim()}\n`);
  // A pick-one block with no choices: the result text's advice, on stderr too.
  const toCheck = result?.structuredContent?.questions_to_check;
  const messageId = result?.structuredContent?.message_id;
  if (Array.isArray(toCheck) && toCheck.length > 0 && typeof messageId === "string") {
    try {
      err(`${questionsToCheckText(messageId, toCheck as InboxQuestionToCheck[]).trim()}\n`);
    } catch {
      // A malformed list (never from this Inbox) prints no advice; the result below still does.
    }
  }
  // A quiet hint (send_message's `hint`): the result text's last line, on stderr too.
  const hint = result?.structuredContent?.hint;
  if (typeof hint === "string" && hint) err(`${hint}\n`);
  await out(`${JSON.stringify(result?.structuredContent ?? { text: words })}\n`);
  return 0;
}
