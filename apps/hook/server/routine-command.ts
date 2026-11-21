/**
 * `plannotator routine …`: the Inbox's routines from a shell (docs/agent-guides/inbox-routines.md), for an agent the
 * person asked to make or change one. Sugar over `plannotator inbox call routine` (inbox-call-command.ts): options
 * in, the `routine` tool's arguments out. Who is calling, starting a stopped Inbox, the refusals and the exit codes
 * are that command's, and every rule (the schedule, the folder, the agent, who may turn it on or run it) is the
 * server's (packages/server/inbox-scheduled.ts): nothing here checks a value, it only says which field a flag fills.
 *
 * stdout: the tool's lines of text, or with --json its structured result as one JSON value. A refusal goes to stderr
 * as `<code>: <message>` and exits 1 (the `agent:` one with ROUTINE_AGENT_HINT under it); bad usage exits 2. `--help` (the overview) and `<command> --help` (its options
 * and examples) answer without an Inbox, routines on or off.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ROUTINE_COMMAND_USAGE, ROUTINE_OP_USAGE, ROUTINE_OPS, type RoutineOp } from "./cli";
import { runInboxCallCommand, type CallCommandDeps } from "./inbox-call-command";
import { writeWholeToStdout } from "./write-whole-stdout";

export { ROUTINE_COMMAND_USAGE, ROUTINE_OP_USAGE };

/** Flags that take a value, by the tool field each fills (`schedule`, `folder` and `attachments` are built below). */
const VALUE_FLAGS: Record<string, string> = {
  "--name": "name",
  "--prompt": "prompt",
  "--cron": "cron",
  "--at": "at",
  "--tz": "tz",
  "--if-missed": "if_missed",
  "--folder": "folder",
  "--agent": "agent",
  "--model": "model",
  "--effort": "effort",
  "--file": "file",
  "--thread": "thread_id",
  "--session": "session",
};
const SWITCHES = new Set(["--scratch", "--no-schedule", "--no-files", "--json"]);

/** The fields' flags, which create and update take. */
const FIELD_FLAGS = ["--name", "--prompt", "--cron", "--at", "--tz", "--if-missed", "--folder", "--scratch", "--agent", "--model", "--effort", "--file"];
/** The flags each command takes beside --json and --session. Exported for the test that keeps each help naming them. */
export const ROUTINE_OP_FLAGS: Record<RoutineOp, readonly string[]> = {
  create: [...FIELD_FLAGS, "--thread"],
  update: [...FIELD_FLAGS, "--no-schedule", "--no-files", "--thread"],
  list: [],
  get: [],
  on: ["--thread"],
  off: ["--thread"],
  run: ["--thread"],
  delete: ["--thread"],
};

export type ParsedRoutineCommand =
  | { kind: "help"; text: string }
  | { kind: "usage"; error: string; op: RoutineOp | null }
  | { kind: "call"; op: RoutineOp; args: Record<string, unknown>; promptFromStdin: boolean; json: boolean; session: string | null };

const isOp = (word: string | undefined): word is RoutineOp => word !== undefined && (ROUTINE_OPS as readonly string[]).includes(word);

/** A path as the person typed it, made whole: `~` is their home, anything else is from the shell's folder. */
function wholePath(value: string, cwd: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return resolve(cwd, value);
}

export function parseRoutineCommand(argv: readonly string[], cwd: string, home: string = homedir()): ParsedRoutineCommand {
  const [first, ...rest] = argv;
  if (first === undefined || first === "--help" || first === "-h") return { kind: "help", text: ROUTINE_COMMAND_USAGE };
  if (!isOp(first)) return { kind: "usage", op: null, error: `${first.startsWith("-") ? `${first} comes after the command` : `${first} is not a routine command`}. The commands: ${ROUTINE_OPS.join(", ")}.` };
  const op = first;
  const usage = (error: string): ParsedRoutineCommand => ({ kind: "usage", op, error });
  const values: Record<string, string> = {};
  const files: string[] = [];
  const switches = new Set<string>();
  const positional: string[] = [];
  // The first thing wrong, said once the whole line is read: a --help anywhere on it (not as a flag's value) wins.
  let wrong: string | null = null;
  let help = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--help" || arg === "-h") help = true;
    else if (Object.hasOwn(VALUE_FLAGS, arg) || SWITCHES.has(arg)) {
      if (arg !== "--json" && arg !== "--session" && !ROUTINE_OP_FLAGS[op].includes(arg)) wrong ??= `routine ${op} does not take ${arg}.`;
      if (SWITCHES.has(arg)) {
        switches.add(arg);
        continue;
      }
      const value = rest[++i];
      if (value === undefined) wrong ??= `${arg} takes a value.`;
      else if (arg === "--file") files.push(value);
      else if (arg in values) wrong ??= `${arg} given twice.`;
      else values[arg] = value;
    } else if (arg.startsWith("--")) wrong ??= `Unknown routine option: ${arg}. A flag and its value are separate words: --name "Dependency check".`;
    else positional.push(arg);
  }
  if (help) return { kind: "help", text: ROUTINE_OP_USAGE[op] };
  if (wrong !== null) return usage(wrong);

  const json = switches.has("--json");
  const session = values["--session"] ?? null;
  const takesId = op !== "create" && op !== "list";
  if (positional.length > 1) return usage(`routine ${op} takes ${takesId ? "one routine id" : "no words"}; quote a value with spaces.`);
  const [word] = positional;

  // The routine tool's fields as one JSON object, in place of options.
  if (word !== undefined && word.trim().startsWith("{")) {
    const fieldFlag = Object.keys(values).find((flag) => flag !== "--session") ?? [...switches].find((flag) => flag !== "--json") ?? (files.length > 0 ? "--file" : undefined);
    if (fieldFlag) return usage(`Give the fields as options or as one JSON object, not both (${fieldFlag}).`);
    let fields: unknown;
    try {
      fields = JSON.parse(word.replace(/^﻿/, ""));
    } catch (error) {
      return usage(`The JSON does not read: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) return usage("The JSON must be one object.");
    const object = fields as Record<string, unknown>;
    if (object.op !== undefined && object.op !== op) return usage(`The JSON says op ${JSON.stringify(object.op)}, the command ${op}.`);
    // Paths in it are made whole as the options' are; anything else is left for the tool to take or refuse.
    const args: Record<string, unknown> = { ...object, op };
    const given = object.folder as { path?: unknown } | null | undefined;
    if (given && typeof given === "object" && typeof given.path === "string") args.folder = { ...given, path: wholePath(given.path, cwd, home) };
    if (Array.isArray(object.attachments)) args.attachments = object.attachments.map((file) => (typeof file === "string" ? wholePath(file, cwd, home) : file));
    return { kind: "call", op, args, promptFromStdin: false, json, session };
  }

  if (takesId && word === undefined) return usage(`routine ${op} takes a routine id (sch_…): 'plannotator routine list' shows them.`);
  if (!takesId && word !== undefined) {
    return usage(op === "create" ? `routine create takes no words: the prompt goes in --prompt, quoted, or --prompt - to read it from stdin.` : "routine list takes no words.");
  }

  const args: Record<string, unknown> = { op };
  if (word !== undefined) args.id = word;
  if ("--name" in values) args.name = values["--name"];
  const promptFromStdin = values["--prompt"] === "-";
  if ("--prompt" in values && !promptFromStdin) args.prompt = values["--prompt"];
  if ("--if-missed" in values) args.if_missed = values["--if-missed"];
  if ("--agent" in values) args.agent = values["--agent"];
  if ("--model" in values) args.model = values["--model"];
  if ("--effort" in values) args.effort = values["--effort"];
  if ("--thread" in values) args.thread_id = values["--thread"];

  const cron = values["--cron"];
  const at = values["--at"];
  const tz = values["--tz"];
  const noSchedule = switches.has("--no-schedule");
  if ([cron !== undefined, at !== undefined, noSchedule].filter(Boolean).length > 1) return usage("Give one of --cron, --at and --no-schedule.");
  if (tz !== undefined && cron === undefined && at === undefined) return usage("--tz goes with --cron or --at: pass the schedule again with its zone.");
  if (cron !== undefined) args.schedule = { cron, ...(tz !== undefined ? { tz } : {}) };
  else if (at !== undefined) args.schedule = { at, ...(tz !== undefined ? { tz } : {}) };
  else if (noSchedule) args.schedule = null;

  const folder = values["--folder"];
  if (folder !== undefined && switches.has("--scratch")) return usage("Give --folder or --scratch, not both.");
  if (folder !== undefined) args.folder = { path: wholePath(folder, cwd, home) };
  else if (switches.has("--scratch")) args.folder = { scratch: true };

  if (files.length > 0 && switches.has("--no-files")) return usage("Give --file or --no-files, not both.");
  if (files.length > 0) args.attachments = files.map((file) => wholePath(file, cwd, home));
  else if (switches.has("--no-files")) args.attachments = [];

  return { kind: "call", op, args, promptFromStdin, json, session };
}

/** Said under the tool's `validation_error: agent: …`: the Inbox could not tell which agent this is, or cannot start that one. */
export const ROUTINE_AGENT_HINT = "Ask the person which agent runs it (claude-code, codex, opencode or pi), then pass that one with --agent. Never pick one yourself.";

/** Run `plannotator routine …`; resolves to the exit code. */
export async function runRoutineCommand(argv: readonly string[], deps: CallCommandDeps): Promise<number> {
  const out = deps.out ?? writeWholeToStdout;
  const err = deps.err ?? ((text: string) => void process.stderr.write(text));
  const parsed = parseRoutineCommand(argv, deps.cwd);
  if (parsed.kind === "help") {
    // Bare `plannotator routine` is bad usage: the overview goes to stderr, as `plannotator card`'s does.
    if (argv.length === 0) {
      err(`${parsed.text}\n`);
      return 2;
    }
    await out(`${parsed.text}\n`);
    return 0;
  }
  if (parsed.kind === "usage") {
    err(`usage: ${parsed.error}\nRun 'plannotator routine ${parsed.op ? `${parsed.op} ` : ""}--help' for ${parsed.op ? "its options and examples" : "the commands"}.\n`);
    return 2;
  }
  const args = { ...parsed.args };
  if (parsed.promptFromStdin) args.prompt = (await (deps.stdin ?? (() => Bun.stdin.text()))()).replace(/^﻿/, "");
  const errWithHint = (text: string) => {
    err(text);
    if (text.startsWith("validation_error: agent: ")) err(`${ROUTINE_AGENT_HINT}\n`);
  };
  return runInboxCallCommand([...(parsed.session !== null ? ["--session", parsed.session] : []), "routine", JSON.stringify(args)], { ...deps, out, err: errWithHint, text: !parsed.json });
}
