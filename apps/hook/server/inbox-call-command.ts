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
 * would read as a result with null fields). With `CallCommandDeps.text` (what
 * `plannotator routine` asks for without --json) it is the result's words
 * instead. A failure goes to stderr as
 * `<code>: <message>`. Exit 0 ok, 1 refused or unreachable, 2 bad usage.
 */

import { statSync } from "node:fs";
import { resolve } from "node:path";
import { planAgentBodyPictures } from "@plannotator/shared/inbox/agent-pictures";
import { decodeInboxAgentPairing, INBOX_AGENT_CALL_ACTIONS, INBOX_AGENT_FETCH_FILE, INBOX_AGENT_ROUTE, INBOX_AGENT_UPLOAD_FINISH, INBOX_AGENT_UPLOAD_PIECE, type InboxAgentPairing } from "@plannotator/shared/inbox/agent-pairing";
import { callInboxThroughRelay, inboxAgentSignalUrl, type InboxAgentRelayOutcome } from "@plannotator/shared/inbox/agent-relay-client";
import { INBOX_HOST_NAMES, INBOX_QWEN_SESSION_ENV, INBOX_T3_HOST, INBOX_T3_THREAD_ENV, inboxTidyMcpLine, parseInboxSessionRef, type InboxTidyMark } from "@plannotator/core/inbox-types";
import { INBOX_MAX_REQUEST_BYTES, INBOX_PEEK_META_KEY, inboxRequestTooLargeMessage, inboxToolCallParams, mcpAnswerOfResponse } from "@plannotator/shared/inbox/connection";
import { inboxEnsureFailedWords, type InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import { attachedImagesNotInBodyText } from "@plannotator/shared/inbox/attached-images";
import { questionsToCheckText } from "@plannotator/shared/inbox/questions-to-check";
import type { InboxQuestionToCheck } from "@plannotator/core/inbox-questions";
import { questionOpenersWithTextText, type QuestionOpenerWithText } from "@plannotator/shared/inbox/question-openers";
import { hasHelpFlag, INBOX_CALL_ACTIONS, INBOX_CALL_USAGE, INBOX_PAIRED_CALL_USAGE } from "./cli";
import { fetchPairedFile, type PairedCall } from "./inbox-call-fetch";
import { fetchFarFile } from "./inbox-call-far-fetch";
import { pairedAttachments } from "./inbox-call-pieces";
import { writeWholeToStdout } from "./write-whole-stdout";
import { AUTHOR_TOOLS, fillInboxToolArguments, type InboxHostSession, INBOX_DSH_ROOT_FOR_ENV, INBOX_DSH_ROOT_SESSION_ENV, INBOX_SESSION_HOST_NAMES, inboxHostSessionFromEnv, inboxSessionProjectFromEnv } from "./inbox-mcp-shim";

/** One request never waits longer: a wedged Inbox must not hang a script. */
const REQUEST_TIMEOUT_MS = 90_000;
const PIECE_WAIT_MS = 60_000;

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

/**
 * The agent a shell that names no session belongs to, by its marker (`SESSIONLESS_HOSTS`: GEMINI_CLI, COPILOT_CLI,
 * CURSOR_AGENT, OPENCODE, CLAUDECODE, OMPCODE, QWEN_CODE, DSH_SHELL): its name, and its host when it has one. A
 * message it sends then reads as that agent's, never as a script's (`inboxSessionlessSend`). With two markers the
 * shell was started inside another agent: Claude Code's `CLAUDECODE` is taken as the outer one, then the table's
 * order decides, so the post still carries a name. Null for a shell with no marker (cron, launchd, a plain terminal).
 */
export function inboxShellAgentOf(env: Record<string, string | undefined>): { name: string; host?: string } | null {
  const markers = SESSIONLESS_HOSTS.filter(({ variable }) => env[variable]);
  const inner = markers.find(({ variable }) => variable !== "CLAUDECODE") ?? markers[0];
  if (!inner) return null;
  const { name, host } = inner;
  return host ? { name, host } : { name };
}

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
    // A bare id this shell names is that session, host and name too: without them a reply to it reads as from
    // "An agent", and the window cannot tell it from a script nothing wakes.
    const own = caller.host === undefined ? named.filter((other) => other.session === caller.session) : [];
    if (own.length === 1) return { ok: true, caller: own[0]! };
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

/** On this computer, `fetch_file` too: it saves a linked machine's file here (inbox-call-far-fetch.ts). Not listed in the usage. */
const INBOX_LOCAL_CALL_ACTIONS: readonly string[] = [...INBOX_CALL_ACTIONS, INBOX_AGENT_FETCH_FILE];

export type ParsedCallCommand =
  | { ok: true; action: string; json: string | null; stdin: boolean; session: string | null }
  | { ok: false; code: string; error: string };

export function parseCallCommand(argv: readonly string[], actions: readonly string[] = INBOX_CALL_ACTIONS): ParsedCallCommand {
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
  if (!actions.includes(action)) {
    // A paired agent's list (INBOX_AGENT_CALL_ACTIONS) names them all, as its usage does.
    const named = actions === INBOX_CALL_ACTIONS || actions === INBOX_LOCAL_CALL_ACTIONS ? actions.filter((name) => name !== "steps" && name !== "routine" && name !== INBOX_AGENT_FETCH_FILE) : actions;
    return { ok: false, code: "unknown_action", error: `${action} is not an Inbox action. Actions: ${named.join(", ")}.` };
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
    return { code: "invalid_json", error: `The arguments are not JSON, so nothing was sent: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { code: "invalid_json", error: "The arguments are not one JSON object, so nothing was sent." };
  const args = value as Record<string, unknown>;
  const identity = IDENTITY_FIELDS.find((field) => field in args);
  if (identity) return { code: "invalid_arguments", error: `${identity}: not taken here, so nothing was sent. --session and this shell say who is calling.` };
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
  /** Print the tool's lines of text instead of its structured result (`plannotator routine` without --json). */
  text?: boolean;
  /** Tests: a paired call's one request (the relay or the door), so it runs with no relay and no Inbox. */
  pairedTransport?: (tool: string, body: Record<string, unknown>, waitMs?: number) => Promise<InboxAgentRelayOutcome>;
}

/** Run `plannotator inbox call …`; resolves to the exit code. */
export async function runInboxCallCommand(argv: readonly string[], deps: CallCommandDeps): Promise<number> {
  const out = deps.out ?? writeWholeToStdout;
  const err = deps.err ?? ((text: string) => void process.stderr.write(text));
  const refused = (code: string, message: string, exit = 1) => {
    err(`${code}: ${message}\n`);
    return exit;
  };
  const paired = Boolean(deps.env.PLANNOTATOR_PAIRING);
  const usage = paired ? INBOX_PAIRED_CALL_USAGE : INBOX_CALL_USAGE;
  if (hasHelpFlag([...argv])) {
    await out(`${usage}\n`);
    return 0;
  }
  const parsed = parseCallCommand(argv, paired ? INBOX_AGENT_CALL_ACTIONS : INBOX_LOCAL_CALL_ACTIONS);
  if (!parsed.ok) {
    err(`${parsed.code}: ${parsed.error}\n${usage}\n`);
    return 2;
  }
  if (deps.askAiChild) return refused("inbox_off", "The Plannotator Inbox is off in an agent that Plannotator's Ask AI started.");
  if (deps.env.PLANNOTATOR_PAIRING) return runPairedCall(parsed, deps, out, err, refused);
  const caller = inboxCallerOf(parsed.session, deps.env);
  if (!caller.ok) return refused(caller.code, caller.message, caller.usage ? 2 : 1);
  const text = parsed.stdin ? await (deps.stdin ?? (() => Bun.stdin.text()))() : (parsed.json ?? "{}");
  const input = argumentsOf(text, deps.cwd);
  if ("error" in input) return refused(input.code, input.error, 2);
  if (parsed.action === INBOX_AGENT_FETCH_FILE) {
    let running: InboxRegistryEntry;
    try {
      running = await deps.ensureRunning();
    } catch (error) {
      return refused("inbox_not_running", inboxEnsureFailedWords(error));
    }
    const fetched = await fetchFarFile(input.args, deps.cwd, running);
    if (!fetched.ok) return refused(fetched.code, fetched.message);
    await out(`${JSON.stringify(fetched.saved)}\n`);
    return 0;
  }

  // With no project_path, the session's own project (its host's PLANNOTATOR_SESSION_PROJECT), wherever the shell has cd'd to.
  const call = fillInboxToolArguments({ method: "tools/call", params: { name: parsed.action, arguments: input.args } }, deps.cwd, null, caller.caller, null, inboxSessionProjectFromEnv(deps.env));
  // An agent's own shell that names no session (Gemini CLI, Copilot CLI, Cursor…): its message carries that agent's name.
  const shellAgent = caller.caller === null && AUTHOR_TOOLS.has(parsed.action) ? inboxShellAgentOf(deps.env) : null;
  if (shellAgent) {
    const filled = call.params!.arguments as Record<string, unknown>;
    filled.agent_name = shellAgent.name;
    if (shellAgent.host) filled.agent_host = shellAgent.host;
  }
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
    return refused("inbox_not_running", inboxEnsureFailedWords(error));
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
  return printResult(answer.result as CallResult | undefined, out, err, deps.text === true);
}

type CallResult = { content?: { text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

type PairedDeps = Pick<CallCommandDeps, "env" | "timeoutMs" | "pairedTransport">;
type PairedLink = {
  ok: true;
  relayed: (InboxAgentPairing & { relay: NonNullable<InboxAgentPairing["relay"]> }) | null;
  transport: (tool: string, body: Record<string, unknown>, waitMs?: number) => Promise<InboxAgentRelayOutcome>;
  resultOf: (outcome: Extract<InboxAgentRelayOutcome, { kind: "answer" }>) => { result: CallResult } | { code: string; message: string };
  /** One call whose result is read here (a piece of a file, a command's route): its structured result, or the refusal as a code and words. */
  call: PairedCall;
};

/**
 * The door actions and refusals only an older Inbox gives a call this command knows is real: `tool_not_allowed` for
 * an action added since, or a path refusal it no longer makes. The person's Plannotator is older than this one.
 * `routine` is refused by an older Inbox in words of its own; "routine is not an Inbox action" is a current Inbox with
 * Routines off (Settings → Capabilities), which updating would not change.
 */
const NEWER_ACTIONS: readonly string[] = [INBOX_AGENT_FETCH_FILE, INBOX_AGENT_ROUTE, INBOX_AGENT_UPLOAD_PIECE, INBOX_AGENT_UPLOAD_FINISH, "routine"];
const OLD_REFUSALS: readonly string[] = ["path_refused", "attachment_path_refused", "image_path_refused", "no_checkout"];
const UPDATE_THERE = " Plannotator on the person's computer is older than this one: ask the person to update it.";
export function inboxPairedSkewNote(tool: string, code: string, words = ""): string {
  const switchedOff = tool === "routine" && /\broutine is not an Inbox action\b/.test(words);
  return (code === "tool_not_allowed" && NEWER_ACTIONS.includes(tool) && !switchedOff) || OLD_REFUSALS.includes(code) ? UPDATE_THERE : "";
}

/** The way to the person's Inbox that PLANNOTATOR_PAIRING names: the agent door with its token, through the relay (or PLANNOTATOR_PAIRING_DOOR). */
function pairedLink(deps: PairedDeps): PairedLink | { ok: false; code: string; message: string; exit: number } {
  const pairing = decodeInboxAgentPairing(deps.env.PLANNOTATOR_PAIRING);
  if (!pairing) return { ok: false, exit: 2, code: "invalid_pairing", message: "PLANNOTATOR_PAIRING is not a whole pairing string from the Inbox: it is cut off or changed, or has spaces or line breaks in it. Ask the person to copy it again, whole (it starts with plannotator-pairing-)." };
  const door = deps.env.PLANNOTATOR_PAIRING_DOOR ? loopbackDoor(deps.env.PLANNOTATOR_PAIRING_DOOR) : null;
  if (deps.env.PLANNOTATOR_PAIRING_DOOR && !door) return { ok: false, exit: 2, code: "pairing_door_needed", message: "PLANNOTATOR_PAIRING_DOOR must be the Inbox's address on this computer (http://127.0.0.1:<port>). Unset it to go through the relay." };
  if (!door && !pairing.relay) {
    return { ok: false, exit: 1, code: "pairing_without_relay", message: "This pairing string was made before the person's Inbox could reach its relay, so it works only on their computer. Ask the person to remove this agent and pair it again." };
  }
  const relayed = !door && pairing.relay ? { ...pairing, relay: pairing.relay } : null;
  const transport = async (tool: string, body: Record<string, unknown>, waitMs?: number): Promise<InboxAgentRelayOutcome> => {
    if (deps.pairedTransport) return deps.pairedTransport(tool, body, waitMs);
    if (relayed) return callInboxThroughRelay(relayed, tool, body, waitMs ? { readWaitMs: waitMs } : {});
    try {
      const response = await fetch(`${door}/api/inbox/agent/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${pairing.token}` },
        body: JSON.stringify({ tool, arguments: body }),
        signal: AbortSignal.timeout(deps.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
      return { kind: "answer", status: response.status, body: await response.text() };
    } catch (error) {
      return { kind: "refused", code: "inbox_no_answer", message: `Plannotator Inbox did not answer: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
  const resultOf = (outcome: Extract<InboxAgentRelayOutcome, { kind: "answer" }>): { result: CallResult } | { code: string; message: string } => {
    let answer: { result?: CallResult; code?: string; error?: string } | null = null;
    try {
      answer = JSON.parse(outcome.body);
    } catch {
      answer = null;
    }
    if (outcome.status === 401 && answer?.code === "device_revoked") return { code: "pairing_removed", message: "This cloud agent was removed from the person's Inbox. Nothing was sent. Ask the person for a new pairing string." };
    if (outcome.status < 200 || outcome.status >= 300 || !answer?.result) return { code: answer?.code ?? "inbox_error", message: answer?.error ?? `The Inbox answered ${outcome.status}.` };
    return { result: answer.result };
  };
  const call: PairedCall = async (tool, body) => {
    const outcome = await transport(tool, body, PIECE_WAIT_MS);
    if (outcome.kind === "refused") return { ok: false, code: outcome.code, message: outcome.message };
    // Only a write is queued (isInboxAgentWrite): a piece of a file, whose message was never sent, or a command's
    // change, applied once when the computer answers.
    if (outcome.kind === "queued" && tool !== INBOX_AGENT_ROUTE) return { ok: false, code: "no_answer", message: "The person's computer did not take the file in time. Nothing was sent. Try again later." };
    if (outcome.kind === "queued") return { ok: false, code: "queued", message: `${outcome.reason === "offline" ? "The person's computer is asleep or offline" : "The person's computer did not answer in time"}. This change waits at the relay and is applied once when it is back. Do not run it again.` };
    const got = resultOf(outcome);
    if ("code" in got) return { ok: false, ...got };
    if (got.result.isError) {
      const text = (got.result.content ?? []).map((part) => part.text ?? "").join("\n");
      const match = /^([a-z][a-z0-9_]*): ([\s\S]*)$/.exec(text);
      const code = match?.[1] ?? "inbox_error";
      return { ok: false, code, message: `${match?.[2] ?? text}${inboxPairedSkewNote(tool, code, text)}` };
    }
    return { ok: true, structured: got.result.structuredContent };
  };
  return { ok: true, relayed, transport, resultOf, call };
}

/**
 * For a command that is a thin client over the window's routes on the person's computer (`inbox rows`, `projects`,
 * `icon`, `export-decisions`), run by a paired cloud agent: its request to `path` goes through the agent door's `route`
 * (packages/server/inbox-agent-routes.ts), and the Inbox's answer comes back as the Response the command reads, so it
 * prints exactly what it prints on that computer. A request that does not reach the Inbox answers 502 with its
 * reason, in the routes' own `{ code, error }`.
 */
export function inboxPairedRouteFetch(deps: PairedDeps): ((path: string, init?: { method?: string; body?: string }) => Promise<Response>) | { code: string; message: string } {
  const link = pairedLink(deps);
  if (!link.ok) return { code: link.code, message: link.message };
  return async (path, init = {}) => {
    const method = init.method ?? "GET";
    const got = await link.call(INBOX_AGENT_ROUTE, { method, path, ...(init.body !== undefined ? { body: JSON.parse(init.body) } : {}) });
    if (!got.ok) return new Response(JSON.stringify({ code: got.code, error: got.message }), { status: 502, headers: { "Content-Type": "application/json" } });
    const answer = got.structured as { status?: number; content_type?: string; body?: string } | undefined;
    return new Response(answer?.body ?? "", { status: answer?.status ?? 502, headers: answer?.content_type ? { "Content-Type": answer.content_type } : {} });
  };
}

/** A paired cloud agent's call: the agent door, with the pairing's token, through the relay. */
async function runPairedCall(
  parsed: Extract<ParsedCallCommand, { ok: true }>,
  deps: CallCommandDeps,
  out: (text: string) => void | Promise<void>,
  err: (text: string) => void,
  refused: (code: string, message: string, exit?: number) => number,
): Promise<number> {
  const link = pairedLink(deps);
  if (!link.ok) return refused(link.code, link.message, link.exit);
  if (parsed.session !== null) return refused("invalid_session", "--session is not taken with PLANNOTATOR_PAIRING: the pairing names the agent.", 2);
  let args: Record<string, unknown>;
  try {
    const value = JSON.parse((parsed.stdin ? await (deps.stdin ?? (() => Bun.stdin.text()))() : (parsed.json ?? "{}")).replace(/^\uFEFF/, "")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return refused("invalid_json", "The arguments are not one JSON object, so nothing was sent.", 2);
    args = value as Record<string, unknown>;
  } catch (error) {
    return refused("invalid_json", `The arguments are not JSON, so nothing was sent: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
  const { relayed, transport, resultOf, call: pieceCall } = link;
  if (parsed.action === INBOX_AGENT_FETCH_FILE) {
    const fetched = await fetchPairedFile(args, deps.cwd, pieceCall);
    if (!fetched.ok) return refused(fetched.code, fetched.message);
    await out(`${JSON.stringify(fetched.saved)}\n`);
    return 0;
  }
  // The pictures the body shows from this machine's disk, as a local agent writes them: sent with the message, each
  // named by its file's name, which is what the door shows it by (packages/shared/inbox/agent-pictures.ts). A path
  // that is no file here is left as it is, for the Inbox to read on the person's computer. The body is send_message's,
  // or a submit_guide's guide intent when it sends none (the one the door shows the pictures of). A routine's files
  // are paths each run reads there, so they go as they are (a `{ "path": … }` one as its path).
  const isFile = (path: string) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  };
  const intent = parsed.action === "submit_guide" && typeof args.body !== "string" ? guideIntent(args.guide) : null;
  const shown = typeof args.body === "string" ? args.body : intent?.intent;
  const pictures =
    typeof shown === "string" && parsed.action !== "routine" ? planAgentBodyPictures(shown, Array.isArray(args.attachments) ? args.attachments : [], deps.cwd, isFile) : null;
  if (pictures && typeof args.body === "string") args.body = pictures.body;
  else if (pictures && intent) args.guide = intent.with(pictures.body);
  if (pictures && pictures.files.length > 0) args.attachments = [...(Array.isArray(args.attachments) ? args.attachments : [])];
  let remote: number[] = [];
  if (Array.isArray(args.attachments) && parsed.action !== "routine") {
    const sent = await pairedAttachments(args.attachments, deps.cwd, pieceCall, pictures?.files ?? []);
    if (!sent.ok) return refused(sent.code, sent.message);
    args.attachments = sent.items;
    remote = sent.remote;
  } else if (Array.isArray(args.attachments)) {
    args.attachments = args.attachments.map((item) => (item && typeof item === "object" && !Array.isArray(item) && typeof (item as { path?: unknown }).path === "string" && Object.keys(item).length === 1 ? (item as { path: string }).path : item));
  }
  /** A refusal of a path left for the person's computer says it was looked for there. */
  const sideOf = (words: string) => {
    const at = /^[a-z][a-z0-9_]*: attachments\[(\d+)\]/.exec(words);
    return at && remote.includes(Number(at[1])) ? `${words} (Looked for on the person's computer: it is no file on this machine, or was given as { "path": … }.)` : words;
  };
  const outcome = await transport(parsed.action, args);
  if (outcome.kind === "refused") return refused(outcome.code, outcome.message);
  if (outcome.kind === "queued") {
    await out(
      `${JSON.stringify({
        queued: true,
        note:
          outcome.reason === "offline"
            ? "The person's computer is asleep or offline. This call waits at the relay and is applied once when it is back. Do not send it again."
            : "The person's computer did not answer in time. This call waits at the relay and is applied once. Do not send it again.",
      })}\n`,
    );
    return 0;
  }
  const got = resultOf(outcome);
  if ("code" in got) return refused(got.code, got.message);
  if (got.result.isError) {
    const words = (got.result.content ?? []).map((part) => part.text ?? "").join("\n");
    const code = /^([a-z][a-z0-9_]*): /.exec(words)?.[1] ?? "";
    got.result.content = [{ text: `${sideOf(words)}${inboxPairedSkewNote(parsed.action, code, words)}` }];
  }
  if (relayed && parsed.action === "whoami" && !got.result.isError) {
    got.result.structuredContent = { ...got.result.structuredContent, signal_url: await inboxAgentSignalUrl(relayed) };
  }
  return printResult(got.result, out, err, deps.text === true);
}

/** `http://127.0.0.1:<port>` (or localhost, [::1]) with nothing after the port, else null. */
function loopbackDoor(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !url.port || url.pathname !== "/" || url.search || url.username) return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function printResult(result: CallResult | undefined, out: (text: string) => void | Promise<void>, err: (text: string) => void, text = false): Promise<number> {
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
  await out(text ? `${words}\n` : `${JSON.stringify(result?.structuredContent ?? { text: words })}\n`);
  return 0;
}

/** A submit_guide's guide intent (the guide as an object or its JSON), and the guide with another intent in its place. */
function guideIntent(guide: unknown): { intent: string; with: (intent: string) => unknown } | null {
  let value = guide;
  const asText = typeof guide === "string";
  if (asText) {
    try {
      value = JSON.parse(guide as string);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { intent?: unknown }).intent !== "string") return null;
  const object = value as Record<string, unknown> & { intent: string };
  return { intent: object.intent, with: (intent) => (asText ? JSON.stringify({ ...object, intent }) : { ...object, intent }) };
}
