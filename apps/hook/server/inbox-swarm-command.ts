/**
 * `plannotator inbox swarm <join|propose|say|doing|status|leave> …`: how a swarm's agents work as one team
 * (docs/agent-guides/inbox-swarm.md). One command, not an action of the agent tool (the owner, 2026-11-24: "don't
 * bloat or change the tool"): a thin client over the Inbox's `POST /api/inbox/swarm` on this computer's listener, or
 * for a paired cloud agent through the agent door (`inboxPairedRouteFetch`), as `inbox capability` is. Who is calling
 * is what `inbox call` takes it to be (`inboxCallerOf`). A thread on a linked computer is asked there by this Inbox.
 *
 * stdout: the result's text (`--json`: the whole answer as one JSON value); nothing on failure. Exit 0 ok, 1 refused
 * or no Inbox (`<code>: <message>` on stderr), 2 bad usage.
 *
 * AGENT-FACING WORDS (the usage, the help section, the refusals here): DRAFT, the owner approves them before merge.
 */

import { inboxEnsureFailedWords, type InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import { hasHelpFlag } from "./cli";
import { inboxCallerOf, inboxPairedRouteFetch, inboxShellAgentOf } from "./inbox-call-command";
import { localRouteFetch, type InboxRouteFetch } from "./inbox-route-fetch";
import { writeWholeToStdout } from "./write-whole-stdout";

const REQUEST_TIMEOUT_MS = 30_000;

/** `plannotator inbox swarm --help` (DRAFT). */
export const INBOX_SWARM_USAGE = [
  "Usage:",
  "  plannotator inbox swarm join <thread> [--as <name>] [--for <member>]",
  '  plannotator inbox swarm propose "<plan>"',
  '  plannotator inbox swarm doing "<one line>"',
  "  plannotator inbox swarm status [<thread>]",
  '  plannotator inbox swarm say "<text>" [--to <name>]',
  "  plannotator inbox swarm leave",
  "",
  "A swarm is agents working on one Inbox thread as one team. The person starts it; you take part with this command.",
  "",
  "join <thread>      Join the swarm of that thread (its id, or the id of any message in it). Do this first.",
  "                   It prints who is in the swarm, the ghost thread's latest messages, and what to run next.",
  "                   Running it again is safe: it changes only your name or --for.",
  "  --as <name>      The name the others use for you. Default: your agent's name (\"Codex\", or \"Codex 2\" if taken).",
  "  --for <member>   You work for that member: a sub-agent names the agent that brought it in.",
  'propose "<plan>"   Your proposal to the person, right after you join: the plan, shown in the thread as your reply.',
  "                   Work starts at once; the person changes it by replying. Use this instead of writing the",
  '                   proposal as a message. One line per agent: "- <name>: <what it will do>". An indented line',
  "                   under it is that agent's sub-agent. A line that is not a list item is the plan in one line.",
  "                   Name each agent as `swarm status` shows it, or as the --as name it will join with.",
  "                   Another agent's proposal adds to the same plan; a line for a name already in it replaces it.",
  'doing "<line>"     Your status: one line of what you are doing now, 200 characters at most.',
  "                   Set it when you start and whenever it changes.",
  "status [<thread>]  Every member: name, where it runs, working, idle or waiting on the person, its status line and",
  "                   when it was set. An agent the person sent the thread to that has not joined shows \"not joined yet\".",
  'say "<text>"       Write in the ghost thread, the agents\' own thread: every other member gets it as a message.',
  "                   The person can read it but is not notified.",
  "  --to <name>      Only that member gets it.",
  "leave              Leave the swarm when your part is done.",
  "",
  "A ghost thread message reaches you as a Plannotator Inbox notice that names who wrote it. Answer with say only if",
  "it asks you something or you have something that agent needs; never reply only to acknowledge.",
  "Bring in a sub-agent or another agent: give it this command and the thread's id, and have it join first",
  "(a sub-agent with --for <your name>). Ask the person only in the thread itself, and only what the other agents",
  "cannot answer.",
  "",
  "--thread <id>: which swarm, when you are in more than one (propose, say, doing, status, leave).",
  "--session <id>: as for 'plannotator inbox call'.",
  "--json: the whole answer as one JSON value.",
  "stdout is the result, and nothing on failure. Exit 0 ok, 1 refused or no Inbox, 2 bad usage.",
].join("\n");

/** The section of `plannotator inbox --help`, while Swarm is on (DRAFT). */
export const INBOX_SWARM_HELP_SECTION: readonly string[] = [
  "## When you are in a swarm",
  "",
  "A swarm is agents working on one thread as one team; the person starts it from New message. You take part through one command; run `plannotator inbox swarm --help` once, it has everything.",
  "",
  "```text",
  "plannotator inbox swarm join <thread> [--as <name>] [--for <member>]",
  'plannotator inbox swarm propose "<plan>"',
  'plannotator inbox swarm doing "<one line>"',
  "plannotator inbox swarm status [<thread>]",
  'plannotator inbox swarm say "<text>" [--to <name>]',
  "plannotator inbox swarm leave",
  "```",
  "",
  "Join first, then propose the plan with `swarm propose`: it shows in the thread as your reply. Give this command and the thread's id to every sub-agent or other agent you bring in, and have each one join first.",
];

/** The task subcommands a later piece builds: refused plainly until then (the approved /swarm text names them). */
const NOT_YET = new Set(["tasks", "take", "done", "add"]);
export const SWARM_NOT_YET_WORDS = "The swarm's task list is not available yet in this Plannotator. Until it is, agree who does what in the ghost thread with `plannotator inbox swarm say`.";

const ACTIONS = ["join", "propose", "say", "doing", "status", "leave"] as const;
type Action = (typeof ACTIONS)[number];

export type ParsedSwarmCommand =
  | { ok: true; call: { action: Action; thread?: string; as?: string; for?: string; text?: string; to?: string }; session: string | null; json: boolean }
  | { ok: false; error: string; notYet?: boolean };

export function parseSwarmCommand(argv: readonly string[]): ParsedSwarmCommand {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  let json = false;
  let session: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (["--as", "--for", "--to", "--thread", "--session"].includes(arg)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) return { ok: false, error: `${arg} takes a value.` };
      if (arg === "--session") session = value;
      else flags[arg.slice(2)] = value;
      continue;
    }
    if (arg.startsWith("--")) return { ok: false, error: `Unknown inbox swarm option: ${arg}.` };
    positional.push(arg);
  }
  const [name, ...rest] = positional;
  if (name && NOT_YET.has(name)) return { ok: false, error: SWARM_NOT_YET_WORDS, notYet: true };
  if (!name || !(ACTIONS as readonly string[]).includes(name)) return { ok: false, error: `inbox swarm takes one of ${ACTIONS.join(", ")}.` };
  const action = name as Action;
  const allowed: Record<Action, string[]> = { join: ["as", "for"], propose: ["thread"], say: ["to", "thread"], doing: ["thread"], status: ["thread"], leave: ["thread"] };
  const wrong = Object.keys(flags).find((flag) => !allowed[action].includes(flag));
  if (wrong) return { ok: false, error: `--${wrong} is not taken by swarm ${action}.` };
  const call: { action: Action; thread?: string; as?: string; for?: string; text?: string; to?: string } = { action, ...flags };
  if (action === "join") {
    if (rest.length !== 1) return { ok: false, error: "swarm join takes the thread's id." };
    call.thread = rest[0];
  } else if (action === "say" || action === "doing" || action === "propose") {
    if (rest.length !== 1 || rest[0]!.trim() === "") return { ok: false, error: `swarm ${action} takes its words, in quotes.` };
    call.text = rest[0];
  } else if (action === "status") {
    if (rest.length > 1) return { ok: false, error: "swarm status takes at most a thread's id." };
    if (rest[0]) call.thread = rest[0];
  } else if (rest.length > 0) return { ok: false, error: "swarm leave takes no words." };
  return { ok: true, call, session, json };
}

/** An Inbox from before the route (as `inboxHasNoCapabilityRoute`): its unknown-route answer, or the door's refusal. */
export function inboxHasNoSwarmRoute(answer: { status: number; json: Record<string, unknown> | null }): boolean {
  const code = answer.json?.code;
  if (answer.status === 404) return typeof code !== "string" || code === "not_found";
  const words = typeof answer.json?.error === "string" ? answer.json.error : "";
  return answer.status === 502 && code === "validation_error" && words.startsWith("method, path:") && !/\bswarm\b/.test(words);
}

export interface SwarmCommandDeps {
  cwd: string;
  env: Record<string, string | undefined>;
  ensureRunning: () => Promise<InboxRegistryEntry>;
  askAiChild?: boolean;
  out?: (text: string) => void | Promise<void>;
  err?: (text: string) => void;
  timeoutMs?: number;
  fetchRoute?: InboxRouteFetch;
}

/** Run `plannotator inbox swarm …`; resolves to the exit code. */
export async function runInboxSwarmCommand(argv: readonly string[], deps: SwarmCommandDeps): Promise<number> {
  const out = deps.out ?? writeWholeToStdout;
  const err = deps.err ?? ((text: string) => void process.stderr.write(text));
  const refused = (code: string, message: string, exit = 1) => {
    err(`${code}: ${message}\n`);
    return exit;
  };
  if (hasHelpFlag([...argv]) || argv.length === 0) {
    await out(`${INBOX_SWARM_USAGE}\n`);
    return argv.length === 0 ? 2 : 0;
  }
  const parsed = parseSwarmCommand(argv);
  if (!parsed.ok) {
    if (parsed.notYet) return refused("not_available", parsed.error);
    err(`usage: ${parsed.error}\n${INBOX_SWARM_USAGE}\n`);
    return 2;
  }
  if (deps.askAiChild) return refused("inbox_off", "The Plannotator Inbox is off in an agent that Plannotator's Ask AI started.");
  const paired = Boolean(deps.env.PLANNOTATOR_PAIRING);
  if (paired && parsed.session !== null) return refused("invalid_session", "--session is not taken with PLANNOTATOR_PAIRING: the pairing names the agent.", 2);
  const body: Record<string, unknown> = { ...parsed.call };
  if (!paired) {
    const caller = inboxCallerOf(parsed.session, deps.env);
    if (!caller.ok) return refused(caller.code, caller.message, caller.usage ? 2 : 1);
    if (!caller.caller) {
      const shell = inboxShellAgentOf(deps.env);
      return refused("session_unknown", `This shell names no agent session${shell ? ` of ${shell.name}` : ""}: pass --session <id> (your agent's session id).`);
    }
    body.by = { host: caller.caller.host, session: caller.caller.session, name: caller.caller.name };
  }
  let route: InboxRouteFetch;
  if (deps.fetchRoute) route = deps.fetchRoute;
  else if (paired) {
    const door = inboxPairedRouteFetch({ env: deps.env, ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}) });
    if ("code" in door) return refused(door.code, door.message);
    route = door;
  } else {
    let entry: InboxRegistryEntry;
    try {
      entry = await deps.ensureRunning();
    } catch (error) {
      return refused("inbox_not_running", inboxEnsureFailedWords(error));
    }
    route = localRouteFetch(entry.port, deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
  }
  let answer: { status: number; json: Record<string, unknown> | null };
  try {
    const response = await route("/api/inbox/swarm", { method: "POST", body: JSON.stringify(body) });
    answer = { status: response.status, json: (await response.json().catch(() => null)) as Record<string, unknown> | null };
  } catch (error) {
    return refused("inbox_no_answer", `Plannotator Inbox did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (inboxHasNoSwarmRoute(answer)) return refused("inbox_needs_update", "This Plannotator Inbox has no swarm command; update Plannotator for it.");
  if (answer.status !== 200 || !answer.json || typeof answer.json.text !== "string") {
    return refused(typeof answer.json?.code === "string" ? answer.json.code : "inbox_error", typeof answer.json?.error === "string" ? answer.json.error : `The Inbox answered ${answer.status}. Nothing changed.`);
  }
  await out(parsed.json ? `${JSON.stringify(answer.json)}\n` : `${answer.json.text}\n`);
  return 0;
}
