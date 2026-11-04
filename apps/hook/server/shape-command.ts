/**
 * `plannotator shape …`: an agent's side of Shape (SPEC.md §4, "CLI").
 * Unreleased (HIDDEN_SUBCOMMANDS): its help text is a DRAFT until the owner
 * approves it word for word.
 *
 *   update   store a version of a board (the first one creates the shape)
 *   read     the latest version, and the notes waiting for the agent
 *   drawing  say "I'm drawing": the board shows it until the next version (10 min at most)
 *   answer   answer the person's Ask (the board shows it under the question)
 *   done     finish a shape
 *   list     the shapes, newest change first
 *
 * It reads and writes the Shape store under the data dir directly; no server
 * is needed (the Shapes server and page are a later step). The session: inside
 * an agent host session the shape is that session's, and in its project,
 * exactly as the card command decides (inbox-mcp-shim.ts).
 *
 * stdout: JSON for update and read (and every command with --json), a line
 * of text otherwise. A refusal goes to stderr as `<code>: <message>` and exits
 * 1; bad usage exits 2.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { resolveInboxProjectRoot } from "@plannotator/server/inbox-project-root";
import { createShapeStore, type ShapeStore } from "@plannotator/shared/shape/store";
import { diffShapeVersions, summarizeShapeDiff, type ShapeSession } from "@plannotator/shared/shape/format";
import { inboxHostSessionFromEnv, inboxProjectFolderFor, inboxSessionProjectFromEnv } from "./inbox-mcp-shim";
import { SHAPE_COMMAND_USAGE } from "./cli";

export { SHAPE_COMMAND_USAGE };

/** DRAFT. What `plannotator shape` (help included) says while Shape is off. */
export const SHAPE_OFF_TEXT = "shape_off: Shape is off. The person turns it on in the Plannotator Inbox: Settings → Capabilities → Shape.";

type Op = "update" | "read" | "drawing" | "answer" | "done" | "list";
const OPS: readonly Op[] = ["update", "read", "drawing", "answer", "done", "list"];

export interface ParsedShapeCommand {
  op: Op;
  id: string | null;
  file: string | null;
  base: number | null;
  thread: string | null;
  through: string | null;
  project: string | null;
  version: number | null;
  notes: boolean;
  all: boolean;
  json: boolean;
  /** answer: the Ask it answers (`shn_…`), and the words. */
  re: string | null;
  text: string | null;
}

const VALUE_FLAGS = new Set(["--file", "--id", "--base", "--thread", "--through", "--project", "--version", "--re", "--text"]);
const ALLOWED: Record<Op, readonly string[]> = {
  update: ["--file", "--id", "--base", "--thread", "--through", "--project", "--json"],
  read: ["--version", "--notes", "--project", "--json"],
  drawing: ["--project", "--json"],
  answer: ["--re", "--text", "--project", "--json"],
  done: ["--project", "--json"],
  list: ["--all", "--json"],
};

export function parseShapeCommand(argv: readonly string[]): { ok: true; command: ParsedShapeCommand } | { ok: false; error: string } {
  const op = argv[0] as Op | undefined;
  if (!op || !OPS.includes(op)) return { ok: false, error: op ? `Unknown shape command: ${op}` : "A shape command: update, read, drawing, answer, done, list or open." };
  const out: ParsedShapeCommand = { op, id: null, file: null, base: null, thread: null, through: null, project: null, version: null, notes: false, all: false, json: false, re: null, text: null };
  const positional: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (!ALLOWED[op].includes(arg)) return { ok: false, error: `shape ${op} does not take ${arg}.` };
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) return { ok: false, error: `${arg} takes a value.` };
      i++;
      if (arg === "--base" || arg === "--version") {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) return { ok: false, error: `${arg} takes a version number (1, 2, …).` };
        if (arg === "--base") out.base = n;
        else out.version = n;
      } else if (arg === "--file") out.file = value;
      else if (arg === "--id") out.id = value;
      else if (arg === "--thread") out.thread = value;
      else if (arg === "--through") out.through = value;
      else if (arg === "--project") out.project = value;
      else if (arg === "--re") out.re = value;
      else if (arg === "--text") out.text = value;
    } else if (arg === "--notes") out.notes = true;
    else if (arg === "--all") out.all = true;
    else if (arg === "--json") out.json = true;
  }
  if (op === "update") {
    if (positional.length) return { ok: false, error: "shape update takes --file <board.json> (and --id <shp_…> to add a version)." };
    if (!out.file) return { ok: false, error: "shape update needs --file <board.json>." };
  } else if (op === "list") {
    if (positional.length) return { ok: false, error: "shape list takes no id." };
  } else {
    if (positional.length > 1) return { ok: false, error: `shape ${op} takes one shape id at most.` };
    out.id = positional[0] ?? null;
  }
  if (op === "answer" && (!out.re || !out.text?.trim())) {
    return { ok: false, error: "shape answer needs --re <shn_…> (the Ask, from `shape read --notes`) and --text '<your answer>'." };
  }
  for (const [flag, value] of [["--thread", out.thread], ["--through", out.through]] as const) {
    if (value !== null && !/^msg_[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) return { ok: false, error: `${flag} takes an Inbox message id (msg_…).` };
  }
  return { ok: true, command: out };
}

export interface ShapeCommandDeps {
  dataDir: string;
  cwd: string;
  env: Record<string, string | undefined>;
  /** Writes one output; a rejected promise means it did not reach the reader (read --notes then marks nothing). */
  stdout?: (text: string) => void | Promise<void>;
  stderr?: (text: string) => void;
  /** The project a folder belongs to (the Inbox's rule). Tests pass a stand-in. */
  projectRootOf?: (folder: string) => Promise<{ root: string; name: string }>;
}

async function defaultProjectRoot(folder: string) {
  const resolved = await resolveInboxProjectRoot(folder);
  return { root: resolved.root, name: resolved.name };
}

/** Write to stdout and settle once the text is flushed (or the pipe is closed). */
function writeStdout(text: string): Promise<void> {
  return new Promise((done, fail) => {
    process.stdout.write(`${text}\n`, (error) => (error ? fail(error) : done()));
  });
}

/** Run one shape command; the exit code. */
export async function runShapeCommand(argv: readonly string[], deps: ShapeCommandDeps): Promise<number> {
  const out = deps.stdout ?? writeStdout;
  const err = deps.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
  const parsed = parseShapeCommand(argv);
  if (!parsed.ok) {
    err(`${parsed.error}\n\n${SHAPE_COMMAND_USAGE}`);
    return 2;
  }
  const c = parsed.command;
  const store = createShapeStore({ dataDir: deps.dataDir });
  const host = inboxHostSessionFromEnv(deps.env);
  const session: ShapeSession | null = host ? { host: host.host, id: host.session } : null;

  const folder = (() => {
    if (c.project) return isAbsolute(c.project) ? c.project : resolve(deps.cwd, c.project);
    return inboxProjectFolderFor(inboxSessionProjectFromEnv(deps.env), host ? { host: host.host, session: host.session } : null, deps.cwd);
  })();
  const projectOf = async () => {
    try {
      if (!statSync(folder).isDirectory()) throw new Error();
    } catch {
      return null;
    }
    return (deps.projectRootOf ?? defaultProjectRoot)(folder);
  };

  /** Output where a closed pipe changes nothing: the reader is gone either way. */
  const say = async (text: string) => {
    try {
      await out(text);
    } catch {
      // nobody is reading
    }
  };

  const refuse = async (code: string, message: string, extra?: unknown) => {
    err(`${code}: ${message}`);
    if (extra !== undefined) await say(JSON.stringify(extra, null, 2));
    return 1;
  };

  /** The shape a call that names none means: the session's newest active one, else this project's. */
  const pick = async (): Promise<string | null> => {
    if (c.id) return c.id;
    const project = await projectOf();
    return store.latestFor({ session, root: project?.root ?? null })?.id ?? null;
  };

  if (c.op === "update") {
    const path = isAbsolute(c.file!) ? c.file! : resolve(deps.cwd, c.file!);
    let board: unknown;
    try {
      board = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      return refuse("invalid", `could not read ${path} as JSON: ${(error as Error).message}`);
    }
    let project: { name: string; root: string } | null = null;
    if (c.id) {
      const record = store.get(c.id);
      if (!record) return refuse("not_found", `No shape ${c.id}. List them with \`plannotator shape list\`.`);
      project = record.project;
    } else {
      project = await projectOf();
      if (!project) return refuse("project_unresolved", `${folder} is not a folder. Pass --project <folder>.`);
    }
    const result = store.update({
      board,
      id: c.id,
      base: c.base,
      thread: c.thread,
      through: c.through,
      project,
      session,
      sourceDir: dirname(path),
    });
    if (!result.ok) {
      if (result.code === "invalid") return refuse("invalid", `the board has problems:\n${result.errors.map((e) => `  - ${e}`).join("\n")}`);
      if (result.code === "stale_base") return refuse("stale_base", result.message, { error: "stale_base", latest: result.latest });
      return refuse(result.code, result.message);
    }
    const before = result.v > 1 ? store.read(result.id, result.v - 1) : null;
    const after = store.read(result.id, result.v);
    const changed = before && after ? summarizeShapeDiff(diffShapeVersions(before, after)) : [];
    await say(JSON.stringify({ id: result.id, v: result.v, created: result.created, changed }, null, 2));
    return 0;
  }

  if (c.op === "list") {
    const shapes = store.list({ state: c.all ? "all" : "active" });
    if (c.json) {
      await say(JSON.stringify({ shapes }, null, 2));
      return 0;
    }
    if (!shapes.length) {
      await say(c.all ? "No shapes." : "No active shapes. `plannotator shape list --all` includes finished ones.");
      return 0;
    }
    for (const s of shapes) {
      const flags = [
        s.state === "finished" ? "finished" : null,
        s.drawing ? "drawing" : null,
        s.waiting ? `${s.waiting} change${s.waiting === 1 ? "" : "s"} waiting` : null,
        s.thread ? `thread ${s.thread}` : null,
      ].filter(Boolean);
      await say(`${s.id}  v${s.latest}  ${s.project.name}  ${s.title}${flags.length ? `  (${flags.join(", ")})` : ""}`);
    }
    return 0;
  }

  const id = await pick();
  if (!id) return refuse("not_found", "No active shape here. Name one: `plannotator shape list`.");
  const record = store.get(id);
  if (!record) return refuse("not_found", `No shape ${id}. List them with \`plannotator shape list\`.`);

  if (c.op === "read") {
    const version = store.read(id, c.version ?? undefined);
    if (!version) return refuse("not_found", `${id} has no version ${c.version}.`);
    if (!c.notes) {
      await say(JSON.stringify({ shape: record, version }, null, 2));
      return 0;
    }
    // The notes count as received only once the agent has them: written first, marked after.
    const waiting = store.waiting(id);
    try {
      await out(JSON.stringify({ shape: record, version, notes: waiting }, null, 2));
    } catch (error) {
      err(`output_failed: the notes were not handed over and still wait: ${(error as Error).message}`);
      return 1;
    }
    store.markDelivered(id, waiting.map((n) => n.id));
    return 0;
  }

  if (c.op === "drawing") {
    if (record.state === "finished") return refuse("finished", `${id} is finished; the person reopens it first.`);
    const next = store.drawing(id);
    if (c.json) await say(JSON.stringify({ id, drawing: next?.drawing ?? null }));
    else await say(`${id}: drawing until the next version (at most 10 minutes).`);
    return 0;
  }

  if (c.op === "answer") {
    if (!session) return refuse("no_session", "shape answer runs inside an agent session (the board shows who answered).");
    const result = store.answer(id, { re: c.re, text: c.text!.trim(), from: session });
    if (!result.ok) return refuse(result.code, result.code === "invalid" ? result.errors.join("; ") : result.message);
    if (c.json) await say(JSON.stringify({ id, note: result.note }));
    else await say(`${id}: answered. The board shows it under the question.`);
    return 0;
  }

  // done
  store.setState(id, "finished");
  if (c.json) await say(JSON.stringify({ id, state: "finished" }));
  else await say(`${id}: finished. It takes no new versions until the person reopens it.`);
  return 0;
}
