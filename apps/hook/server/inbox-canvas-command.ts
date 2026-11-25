/**
 * `plannotator inbox canvas <thread> …`: a thread's canvas from a shell (packages/server/inbox-canvas-agent.ts). A
 * command and not an action of the agent tool (the owner, 2026-11-24: a feature some agents use adds no action and no
 * description to the tool; it is taught where it starts and in the CLI's help): a thin client over the Inbox's
 * `/api/inbox/canvas/agent` on this computer's listener, or for a paired cloud agent through the agent door
 * (`inboxPairedRouteFetch`), as `inbox capability` is. Who is calling is what `inbox call` takes it to be
 * (`inboxCallerOf`), so the canvas remembers what it showed this session.
 *
 * stdout: the answer's text; nothing on failure. Exit 0 ok, 1 refused or no Inbox (`<code>: <answer>` on stderr), 2
 * bad usage.
 */

import { INBOX_CANVAS_AGENT_ROUTE } from "@plannotator/shared/inbox/canvas/command";
import { inboxEnsureFailedWords, type InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import { hasHelpFlag } from "./cli";
import { inboxCallerOf, inboxPairedRouteFetch, inboxShellAgentOf } from "./inbox-call-command";
import { localRouteFetch, type InboxRouteFetch } from "./inbox-route-fetch";
import { writeWholeToStdout } from "./write-whole-stdout";

/** A picture waits on an open window (up to 8 s a piece, 8 pieces), a mermaid change up to 12 s. */
const REQUEST_TIMEOUT_MS = 120_000;
const ROUTE = INBOX_CANVAS_AGENT_ROUTE;

export const INBOX_CANVAS_USAGE = [
  "Usage:",
  "  plannotator inbox canvas <thread> [--in <frame>] [--after <id>] [--things <id>,<id>]",
  "  plannotator inbox canvas <thread> --picture [<thing>]",
  "  plannotator inbox canvas <thread> --base <rev> --do '<changes>'",
  "",
  "A thread's canvas: the Excalidraw drawing the person sketches on, which you read and change.",
  "<thread> is the thread's id, or a message's in it. Works while the person has Canvas on",
  "(Settings → Capabilities); otherwise it answers canvas_off.",
  "",
  "Read: one line per thing (its kind, its id, its words, where it is) and the canvas's rev.",
  "Every answer opens with what others changed since your last look.",
  "  plannotator inbox canvas msg_7Kq2Lm",
  "  --in <frame>       only one frame (its id or title)",
  "  --after <id>       the rest of a cut reading (a cut reading ends with this command)",
  "  --things <id>,...  exactly those things, with all their words",
  "",
  "Picture: writes a PNG and prints its path. Name a thing for that part only (repeat for more).",
  "  plannotator inbox canvas msg_7Kq2Lm --picture",
  "  plannotator inbox canvas msg_7Kq2Lm --picture kX3v9QpL",
  "",
  "Change: --do is a JSON list of changes, all made or none (- reads it from stdin). --base is the",
  "rev of your last answer. A change lands only on things an answer showed you as they are now;",
  "otherwise nothing changes, the answer shows them, and the same change sent again goes through.",
  "Name a thing by its id or its whole words, one an earlier change in the list adds too.",
  "  plannotator inbox canvas msg_7Kq2Lm --base 4 --do '[{\"add\": \"box\", \"text\": \"Fraud check\", \"rightOf\": \"Checkout\"}]'",
  "One verb per change:",
  "  add      {\"add\": \"note\", \"text\": \"p95 is 1.8 s\", \"near\": \"kX3v9QpL\"}",
  "           box, ellipse, diamond, note, text, frame, or mermaid (text is a flowchart or",
  "           sequence diagram). Place with near, rightOf, leftOf, above, below, in (a frame) or",
  "           \"at\": [x, y]. Optional \"size\": [w, h] and \"color\": black, gray, red, pink, violet,",
  "           blue, teal, green, yellow, orange.",
  "  connect  {\"connect\": \"Checkout\", \"to\": \"Fraud check\", \"label\": \"before the charge\"}  (the arrow points at to)",
  "  set      {\"set\": \"kX3v9QpL\", \"text\": \"Fraud check (sync)\", \"color\": \"red\"}",
  "  move     {\"move\": \"Fraud check\", \"below\": \"Checkout\"}",
  "  remove   {\"remove\": \"kX3v9QpL\"}",
  "  frame    {\"frame\": [\"Checkout\", \"Fraud check\"], \"title\": \"Payment\"}",
  "  replace  {\"replace\": \"Payment\", \"with\": [{\"add\": \"box\", \"text\": \"Charge\"}]}",
  "           a frame keeps its place; what it holds is replaced.",
  "Change it only when the person asks; a selection they send asks you to work on it. They see",
  "your change at once and can undo it; nothing is sent to them.",
  "",
  "--session <id>: as for 'plannotator inbox call'.",
  "stdout is the answer, and nothing on failure. Exit 0 ok, 1 refused or no Inbox (<code>: <answer>",
  "on stderr; canvas_unchanged: nothing changed), 2 bad usage.",
].join("\n");

/** What the command asks the Inbox (inbox-canvas-agent.ts `canvasAgentAskOf`), and the stdin flag of `--do -`. */
export type ParsedCanvasCommand =
  | { ok: true; ask: Record<string, unknown>; doFromStdin: boolean; session: string | null }
  | { ok: false; error: string };

/** The command's arguments as the ask the route takes. Bad usage (an unknown flag, `--do` that is not a JSON list) is refused here. */
export function parseCanvasCommand(argv: readonly string[]): ParsedCanvasCommand {
  const positional: string[] = [];
  const ask: Record<string, unknown> = {};
  const things: string[] = [];
  const pictures: string[] = [];
  let picture = false;
  let doText: string | null = null;
  let session: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--picture") {
      picture = true;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) pictures.push(argv[++i]!);
      continue;
    }
    const flag = ({ "--in": "in", "--after": "after_thing", "--things": "things", "--base": "base", "--do": "do", "--session": "session" } as const)[arg];
    if (flag) {
      const value = argv[++i];
      if (value === undefined || (value.startsWith("--") && value !== "-")) return { ok: false, error: `${arg} takes a value.` };
      if (flag === "session") session = value;
      else if (flag === "things") things.push(...value.split(",").map((one) => one.trim()).filter(Boolean));
      else if (flag === "base") {
        if (!/^\d+$/.test(value)) return { ok: false, error: `--base takes the rev of your last answer, a whole number, not ${value}.` };
        ask.base = Number(value);
      } else if (flag === "do") doText = value;
      else ask[flag] = value;
    } else if (arg.startsWith("--")) return { ok: false, error: `Unknown inbox canvas option: ${arg}.` };
    else positional.push(arg);
  }
  if (positional.length !== 1) return { ok: false, error: positional.length === 0 ? "inbox canvas takes the thread's id." : `inbox canvas takes one thread, not ${positional.join(" ")}.` };
  ask.thread_id = positional[0];
  if (things.length > 0) ask.things = things;
  if (picture) ask.picture = pictures.length === 0 ? true : pictures.length === 1 ? pictures[0] : pictures;
  if (doText !== null && picture) return { ok: false, error: "--do and --picture are two calls: change it, then picture it." };
  if (doText !== null && (ask.in !== undefined || ask.after_thing !== undefined || ask.things !== undefined)) return { ok: false, error: "--do takes no --in, --after or --things: name the things in the changes." };
  if (ask.base !== undefined && doText === null) return { ok: false, error: "--base goes with --do." };
  if (doText === "-") return { ok: true, ask, doFromStdin: true, session };
  if (doText !== null) {
    const changes = changesOf(doText);
    if (!changes.ok) return changes;
    ask.do = changes.list;
  }
  return { ok: true, ask, doFromStdin: false, session };
}

/** `--do`'s JSON: a list of changes (one change alone is taken as a list of one). */
function changesOf(text: string): { ok: true; list: unknown[] } | { ok: false; error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    return { ok: false, error: `--do is not JSON, so nothing was sent: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return { ok: true, list: [value] };
  if (!Array.isArray(value)) return { ok: false, error: "--do takes a JSON list of changes, for example '[{\"add\": \"note\", \"text\": \"…\"}]'." };
  return { ok: true, list: value };
}

/**
 * An Inbox from before the route: on this computer its unknown-route answer (`404`, `not_found`), or none at all;
 * through the agent door its `route` refusing the request with the list of those it carries, which does not name canvas.
 */
export function inboxHasNoCanvasRoute(answer: { status: number; json: Record<string, unknown> | null }): boolean {
  const code = answer.json?.code;
  if (answer.status === 404) return typeof code !== "string" || code === "not_found";
  const words = typeof answer.json?.error === "string" ? answer.json.error : "";
  return answer.status === 502 && code === "validation_error" && words.startsWith("method, path:") && !/\bcanvas\b/.test(words);
}

export interface CanvasCommandDeps {
  env: Record<string, string | undefined>;
  ensureRunning: () => Promise<InboxRegistryEntry>;
  /** Inside an agent Plannotator's Ask AI started: the Inbox is off there, as for `inbox call`. */
  askAiChild?: boolean;
  stdin?: () => Promise<string>;
  out?: (text: string) => void | Promise<void>;
  err?: (text: string) => void;
  timeoutMs?: number;
  /** Tests, and a paired cloud agent: the way to the Inbox's routes, in place of this computer's listener. */
  fetchRoute?: InboxRouteFetch;
}

/** Run `plannotator inbox canvas …`; resolves to the exit code. */
export async function runInboxCanvasCommand(argv: readonly string[], deps: CanvasCommandDeps): Promise<number> {
  const out = deps.out ?? writeWholeToStdout;
  const err = deps.err ?? ((text: string) => void process.stderr.write(text));
  const refused = (code: string, message: string, exit = 1) => {
    err(`${code}: ${message}\n`);
    return exit;
  };
  if (hasHelpFlag([...argv])) {
    await out(`${INBOX_CANVAS_USAGE}\n`);
    return 0;
  }
  const parsed = parseCanvasCommand(argv);
  if (!parsed.ok) {
    err(`usage: ${parsed.error}\nplannotator inbox canvas --help shows how.\n`);
    return 2;
  }
  const body: Record<string, unknown> = { ...parsed.ask };
  if (parsed.doFromStdin) {
    const changes = changesOf(await (deps.stdin ?? (() => Bun.stdin.text()))());
    if (!changes.ok) return refused("usage", changes.error, 2);
    body.do = changes.list;
  }
  if (deps.askAiChild) return refused("inbox_off", "The Plannotator Inbox is off in an agent that Plannotator's Ask AI started.");
  const paired = Boolean(deps.env.PLANNOTATOR_PAIRING);
  if (paired && parsed.session !== null) return refused("invalid_session", "--session is not taken with PLANNOTATOR_PAIRING: the pairing names the agent.", 2);
  // Who is asking: the canvas remembers what it showed each session. Through the door the pairing names the agent.
  if (!paired) {
    const caller = inboxCallerOf(parsed.session, deps.env);
    if (!caller.ok) return refused(caller.code, caller.message, caller.usage ? 2 : 1);
    const shell = caller.caller ? null : inboxShellAgentOf(deps.env);
    const by = caller.caller ? { host: caller.caller.host, session: caller.caller.session, name: caller.caller.name } : shell ? { host: shell.host, name: shell.name } : null;
    if (by) body.by = by;
  }
  let route: InboxRouteFetch;
  if (deps.fetchRoute) route = deps.fetchRoute;
  else if (paired) {
    const door = inboxPairedRouteFetch({ env: deps.env, timeoutMs: deps.timeoutMs ?? REQUEST_TIMEOUT_MS });
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
    const response = await route(ROUTE, { method: "POST", body: JSON.stringify(body) });
    answer = { status: response.status, json: (await response.json().catch(() => null)) as Record<string, unknown> | null };
  } catch (error) {
    return refused("inbox_no_answer", `Plannotator Inbox did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (inboxHasNoCanvasRoute(answer)) return refused("inbox_needs_update", "This Plannotator Inbox has no canvas command; update Plannotator for it.");
  if (answer.status !== 200 || !answer.json || typeof answer.json.text !== "string") {
    return refused(typeof answer.json?.code === "string" ? answer.json.code : "inbox_error", typeof answer.json?.error === "string" ? answer.json.error : `The Inbox answered ${answer.status}. Nothing changed.`);
  }
  await out(`${answer.json.text}\n`);
  return 0;
}
