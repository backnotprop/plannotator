/**
 * `plannotator inbox capability [<capability> on|off] [--thread <id>]`: the Inbox's capability switches from a shell,
 * for an agent the person asks (packages/server/inbox-capability-agent.ts). A turn applies on every linked computer
 * (one set of switches), so there is no computer to name. A command and not
 * an action of the agent tool (the owner, 2026-11-24): a thin client over the Inbox's `/api/inbox/capability` on this
 * computer's listener, or for a paired cloud agent through the agent door (`inboxPairedRouteFetch`), as `inbox rows`
 * is. Who is calling is what `inbox call` takes it to be (`inboxCallerOf`), so the person's line is the agent's. Works
 * whatever is on: it is how a capability that is off gets turned on.
 *
 * stdout: the result as one JSON value (`text` and the switches); nothing on failure. Exit 0 ok, 1 refused or no
 * Inbox (`<code>: <message>` on stderr), 2 bad usage.
 */

import { INBOX_CAPABILITY_AGENT_IDS } from "@plannotator/core/inbox-types";
import { inboxEnsureFailedWords, type InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import { hasHelpFlag } from "./cli";
import { inboxCallerOf, inboxPairedRouteFetch, inboxShellAgentOf } from "./inbox-call-command";
import { inboxProjectFolderFor, inboxSessionProjectFromEnv } from "./inbox-mcp-shim";
import { localRouteFetch, type InboxRouteFetch } from "./inbox-route-fetch";
import { writeWholeToStdout } from "./write-whole-stdout";

/** One request never waits longer: a wedged Inbox must not hang the agent. */
const REQUEST_TIMEOUT_MS = 30_000;

export const INBOX_CAPABILITY_USAGE = [
  "Usage:",
  "  plannotator inbox capability",
  "  plannotator inbox capability <capability> on|off [--thread <id>]",
  "",
  "Lists the Inbox's capabilities (Settings → Capabilities) and whether each is on, or turns one on or off.",
  "Turn one on or off when the person asks you to; not on your own initiative.",
  `<capability>: ${INBOX_CAPABILITY_AGENT_IDS.join(", ")}.`,
  "--thread <id>: the thread you work in; the line for the person goes there.",
  "--session <id>: as for 'plannotator inbox call'.",
  "",
  "stdout is the result as one JSON value, and nothing on failure. Exit 0 ok, 1 refused or no Inbox, 2 bad usage.",
].join("\n");

/** What the command asks the Inbox: `capability` and `on` for a turn, neither to list them. */
export type ParsedCapabilityCommand = { ok: true; call: { capability?: string; on?: boolean; thread_id?: string }; session: string | null } | { ok: false; error: string };

export function parseCapabilityCommand(argv: readonly string[]): ParsedCapabilityCommand {
  const positional: string[] = [];
  const call: { thread_id?: string } = {};
  let session: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const flag = arg === "--thread" ? "thread_id" : arg === "--session" ? "session" : null;
    if (flag) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) return { ok: false, error: `${arg} takes a value.` };
      if (flag === "session") session = value;
      else call[flag] = value;
    } else if (arg.startsWith("--")) return { ok: false, error: `Unknown inbox capability option: ${arg}.` };
    else positional.push(arg);
  }
  if (positional.length === 0) return { ok: true, call, session };
  if (positional.length !== 2) return { ok: false, error: "inbox capability takes a capability and on or off, or nothing to list them." };
  const [name, state] = positional as [string, string];
  if (!(INBOX_CAPABILITY_AGENT_IDS as readonly string[]).includes(name)) return { ok: false, error: `Unknown capability ${name}: one of ${INBOX_CAPABILITY_AGENT_IDS.join(", ")}.` };
  if (state !== "on" && state !== "off") return { ok: false, error: `on or off, not ${state}.` };
  return { ok: true, call: { capability: name, on: state === "on", ...call }, session };
}

/**
 * An Inbox from before the route: on this computer its unknown-route answer (`404`, `not_found`, which the route
 * itself never answers to this computer's agents), or none at all; through the agent door its `route` refusing the
 * request with the list of those it carries, which does not name capability.
 */
export function inboxHasNoCapabilityRoute(answer: { status: number; json: Record<string, unknown> | null }): boolean {
  const code = answer.json?.code;
  if (answer.status === 404) return typeof code !== "string" || code === "not_found";
  const words = typeof answer.json?.error === "string" ? answer.json.error : "";
  return answer.status === 502 && code === "validation_error" && words.startsWith("method, path:") && !/\bcapability\b/.test(words);
}

export interface CapabilityCommandDeps {
  cwd: string;
  env: Record<string, string | undefined>;
  ensureRunning: () => Promise<InboxRegistryEntry>;
  /** Inside an agent Plannotator's Ask AI started: the Inbox is off there, as for `inbox call`. */
  askAiChild?: boolean;
  out?: (text: string) => void | Promise<void>;
  err?: (text: string) => void;
  timeoutMs?: number;
  /** Tests, and a paired cloud agent: the way to the Inbox's routes, in place of this computer's listener. */
  fetchRoute?: InboxRouteFetch;
}

/** Run `plannotator inbox capability …`; resolves to the exit code. */
export async function runInboxCapabilityCommand(argv: readonly string[], deps: CapabilityCommandDeps): Promise<number> {
  const out = deps.out ?? writeWholeToStdout;
  const err = deps.err ?? ((text: string) => void process.stderr.write(text));
  const refused = (code: string, message: string, exit = 1) => {
    err(`${code}: ${message}\n`);
    return exit;
  };
  if (hasHelpFlag([...argv])) {
    await out(`${INBOX_CAPABILITY_USAGE}\n`);
    return 0;
  }
  const parsed = parseCapabilityCommand(argv);
  if (!parsed.ok) {
    err(`usage: ${parsed.error}\n${INBOX_CAPABILITY_USAGE}\n`);
    return 2;
  }
  if (deps.askAiChild) return refused("inbox_off", "The Plannotator Inbox is off in an agent that Plannotator's Ask AI started.");
  const paired = Boolean(deps.env.PLANNOTATOR_PAIRING);
  if (paired && parsed.session !== null) return refused("invalid_session", "--session is not taken with PLANNOTATOR_PAIRING: the pairing names the agent.", 2);
  // Who is turning it, for the person's line: through the door the pairing names the agent, and its project.
  const body: Record<string, unknown> = { ...parsed.call };
  if (!paired) {
    const caller = inboxCallerOf(parsed.session, deps.env);
    if (!caller.ok) return refused(caller.code, caller.message, caller.usage ? 2 : 1);
    const shell = caller.caller ? null : inboxShellAgentOf(deps.env);
    const by = caller.caller ? { host: caller.caller.host, session: caller.caller.session, name: caller.caller.name } : shell ? { host: shell.host, name: shell.name } : null;
    if (by) body.by = by;
    body.project_path = inboxProjectFolderFor(inboxSessionProjectFromEnv(deps.env), caller.caller, deps.cwd);
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
  // A list reads (GET, so through the door it is never held as a write); a turn writes.
  const turn = parsed.call.on !== undefined;
  const path = "/api/inbox/capability";
  let answer: { status: number; json: Record<string, unknown> | null };
  try {
    const response = await route(path, turn ? { method: "POST", body: JSON.stringify(body) } : undefined);
    answer = { status: response.status, json: (await response.json().catch(() => null)) as Record<string, unknown> | null };
  } catch (error) {
    return refused("inbox_no_answer", `Plannotator Inbox did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (inboxHasNoCapabilityRoute(answer)) return refused("inbox_needs_update", "This Plannotator Inbox has no capability command; update Plannotator for it.");
  if (answer.status !== 200 || !answer.json || typeof answer.json.text !== "string") {
    return refused(typeof answer.json?.code === "string" ? answer.json.code : "inbox_error", typeof answer.json?.error === "string" ? answer.json.error : `The Inbox answered ${answer.status}. Nothing changed.`);
  }
  await out(`${JSON.stringify(answer.json)}\n`);
  return 0;
}
