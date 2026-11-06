/**
 * `plannotator system …` (System build spec, step A7): a thin file over
 * @plannotator/system, for the agents that draw a project's System drawing and
 * the launchd job that keeps it current. The subcommands and flags are exactly
 * the package's SYSTEM_COMMANDS, which its recipes (recipe/DRAW.md, UPDATE.md,
 * REVIEW.md) name too; the help is SYSTEM_COMMAND_USAGE in cli.ts.
 *
 *  - check: the loader, then every cited path at `sources.repos.<alias>.at`.
 *  - gate: `gateRepo` over the drawing on disk.
 *  - tick: one scheduled check (`tick`), what the plist runs.
 *  - revision: store an open pull request's revision, refused unless it loads
 *    against the drawing committed on the default branch.
 *  - schedule install | remove | list: the launchd job.
 *
 * The contract is `plannotator inbox call`'s: stdout the result (one JSON
 * value; check prints lines unless --json) and nothing on failure, stderr
 * `<code>: <message>`, exit 0 ok, 1 failed, 2 bad usage. check's findings are
 * its result: printed, with exit 1.
 *
 * Nothing here edits the project's repo. launchctl, the redraw agent, the
 * forge and the clock come in through `deps`, so tests never load a job, run
 * a model or reach GitHub.
 */

import { existsSync, lstatSync, statSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { citations, formatIssue, MAX_FILE_BYTES, parseRevision, type LoadIssue } from "@plannotator/system";
import {
  check,
  checkKey,
  DRAWING_DIR,
  gateRepo,
  launchAgentsDir,
  load,
  loadCommitted,
  overfullPlacements,
  schedule,
  SYSTEM_TICK_INTERVAL_SECONDS,
  systemPaths,
  tick,
  type CommandRunner,
  type TickDeps,
} from "@plannotator/system/node";
import { resolveInboxProjectRoot } from "@plannotator/server/inbox-project-root";
import { inboxProjectKey } from "@plannotator/shared/inbox/project-key";
import { hasHelpFlag, SYSTEM_COMMAND_USAGE } from "./cli";

export { SYSTEM_COMMAND_USAGE };

export interface SystemCommandDeps {
  cwd: string;
  /** The Inbox's data folder (`getPlannotatorDataDir()`): setup.json, state.json and stored reviews live under it. */
  dataDir: string;
  env: Record<string, string | undefined>;
  /** The command that runs this plannotator: one word for the installed binary, `bun <script>` from a source checkout. */
  self: readonly string[];
  /** stdin as text, up to `max` bytes; null when there is more. */
  stdin?: (max: number) => Promise<string | null>;
  stdout?: (text: string) => Promise<void>;
  stderr?: (text: string) => void;
  /** launchctl, the agents folder and the user id: tests pass a recorder and a temp folder. */
  schedule?: { run?: CommandRunner; agentsDir?: string; uid?: number };
  /** The tick's agent, forge and note. */
  tick?: TickDeps;
  now?: Date;
}

class UsageError extends Error {}

type Flags = { values: Map<string, string[]>; words: string[] };

/**
 * Parse `--flag value` and `--flag=value` for the flags a subcommand takes, and
 * `--json` as a switch. A lone `-` is a word (revision's stdin). Anything else
 * is bad usage.
 */
function parseFlags(argv: readonly string[], valueFlags: readonly string[], switches: readonly string[] = [], repeatable: readonly string[] = []): Flags {
  const values = new Map<string, string[]>();
  const words: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "-" || !arg.startsWith("-")) {
      words.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (switches.includes(name) && eq < 0) {
      values.set(name, ["true"]);
      continue;
    }
    if (!valueFlags.includes(name)) throw new UsageError(`unknown option ${name}`);
    const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined || value === "" || (eq < 0 && value.startsWith("--"))) throw new UsageError(`${name} needs a value`);
    const seen = values.get(name);
    if (seen && !repeatable.includes(name)) throw new UsageError(`${name} may be given only once`);
    values.set(name, [...(seen ?? []), value]);
  }
  return { values, words };
}

const one = (f: Flags, name: string) => f.values.get(name)?.[0];
function required(f: Flags, name: string): string {
  const value = one(f, name);
  if (value === undefined) throw new UsageError(`${name} is required`);
  return value;
}
function noWords(f: Flags, sub: string) {
  if (f.words.length) throw new UsageError(`${sub} takes no argument "${f.words[0]}"`);
}

/** The nearest folder, from `start` up, that holds a drawing; null when none does. */
function findDrawingRoot(start: string): string | null {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, DRAWING_DIR, "system.yaml"))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/** True when something is at `path`, a symlink included (dangling or not). */
const lexists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const isDir = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** A failure: `<code>: <message>` on stderr, nothing on stdout, exit 1. */
class Refusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** The repo folder a check or a gate is about: the flag, else the nearest folder with a drawing. */
function repoFolder(deps: SystemCommandDeps, flag: string | undefined, name: string, from?: string): string {
  if (flag !== undefined) {
    const root = resolve(deps.cwd, flag);
    if (!isDir(root)) throw new Refusal("not_a_folder", `${name} ${flag}: no such folder`);
    return root;
  }
  const found = findDrawingRoot(from ?? deps.cwd);
  if (!found) throw new Refusal("no_drawing", `no ${DRAWING_DIR}/system.yaml in ${from ?? deps.cwd} or any folder above it; pass ${name} <repo folder>`);
  return found;
}

const firstLine = (text: string) => text.split("\n")[0]!.trim();
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

async function runCheck(argv: readonly string[], deps: SystemCommandDeps, out: (text: string) => Promise<void>, err: (text: string) => void): Promise<number> {
  const f = parseFlags(argv, ["--root", "--dir", "--repo", "--at"], ["--json"], ["--repo"]);
  noWords(f, "check");
  const dirFlag = one(f, "--dir");
  const dir0 = dirFlag === undefined ? undefined : resolve(deps.cwd, dirFlag);
  // with --dir and no --root, the repo is the nearest folder up from the drawing's that holds one
  const root = repoFolder(deps, one(f, "--root"), "--root", dir0 ? join(dir0, "..", "..") : undefined);
  const dir = dir0 ?? join(root, DRAWING_DIR);
  const roots: Record<string, string> = Object.create(null);
  for (const spec of f.values.get("--repo") ?? []) {
    const eq = spec.indexOf("=");
    if (eq <= 0 || eq === spec.length - 1) throw new UsageError(`--repo takes <alias>=<folder>, not "${spec}"`);
    const alias = spec.slice(0, eq);
    if (alias === "self") throw new UsageError("--repo self=…: this repo is --root");
    if (Object.hasOwn(roots, alias)) throw new UsageError(`--repo ${alias} is given twice`);
    const folder = resolve(deps.cwd, spec.slice(eq + 1));
    if (!isDir(folder)) throw new Refusal("not_a_folder", `--repo ${spec}: no such folder`);
    roots[alias] = folder;
  }
  const at = one(f, "--at");
  if (at !== undefined && (at.startsWith("-") || /\s/.test(at))) throw new UsageError(`--at takes a commit, not "${at}"`);

  // no system.yaml at all is no drawing, as gate says it, not a finding; a symlinked one is the loader's to report
  if (!lexists(join(dir, "system.yaml"))) throw new Refusal("no_drawing", `no drawing in ${dir}`);

  const result = await check({ dir, root, roots, ...(at ? { at } : {}) });
  // which fields cite each missing path, so the fix is one look away
  const model = result.missing.length ? (await load(dir)).model : null;
  const citedBy: Record<string, string[]> = {};
  if (model) {
    for (const c of citations(model)) {
      const key = c.repo === "self" ? c.path : `${c.repo}:${c.path}`;
      if (!result.missing.includes(key)) continue;
      const fields: string[] = [];
      if (c.by.kind === "part") fields.push(`parts.${c.by.id}.code`);
      else if (Object.hasOwn(model.flows, c.by.id)) {
        // a line cites a file at each end: name the end (or both), so the fix is one look away
        const code = model.flows[c.by.id]!.code;
        for (const end of ["from", "to"] as const) {
          if (code[end]?.repo === c.repo && code[end]?.path === c.path) fields.push(`flows.${c.by.id}.code.${end}`);
        }
      }
      for (const field of fields) if (!(citedBy[key] ??= []).includes(field)) citedBy[key]!.push(field);
    }
  }
  const clean = !result.errors.length && !result.warnings.length && !result.missing.length;
  if (one(f, "--json")) {
    await out(JSON.stringify({ ok: clean, errors: result.errors, warnings: result.warnings, missing: result.missing, cited_by: citedBy }));
  } else {
    const lines: string[] = [];
    for (const e of result.errors) lines.push(`error: ${formatIssue(e)}`);
    for (const w of result.warnings) lines.push(`warning: ${formatIssue(w)}`);
    for (const m of result.missing) {
      const alias = m.includes(":") ? m.slice(0, m.indexOf(":")) : "self";
      const commit = alias === "self" && at ? at : model?.sources?.repos[alias]?.at;
      const where = commit ? `not in the repo at ${/^[0-9a-f]{40,64}$/.test(commit) ? commit.slice(0, 12) : commit}` : "not in the repo";
      const by = citedBy[m]?.length ? `cited by ${citedBy[m]!.join(", ")}; ` : "";
      lines.push(`missing: ${m} (${by}${where})`);
    }
    if (clean) lines.push(`clean: ${resolve(dir)}`);
    await out(lines.join("\n"));
  }
  if (clean) return 0;
  const counts = [plural(result.errors.length, "error"), plural(result.warnings.length, "warning"), plural(result.missing.length, "missing path")];
  err(`not_clean: ${counts.join(", ")}`);
  return 1;
}

async function runGate(argv: readonly string[], deps: SystemCommandDeps, out: (text: string) => Promise<void>): Promise<number> {
  const f = parseFlags(argv, ["--project", "--from", "--to"]);
  noWords(f, "gate");
  const from = required(f, "--from");
  const to = required(f, "--to");
  const root = repoFolder(deps, one(f, "--project"), "--project");
  const loaded = await load(join(root, DRAWING_DIR));
  if (!loaded.model) {
    if (!loaded.errors.length) throw new Refusal("no_drawing", `no drawing in ${join(root, DRAWING_DIR)}`);
    throw new Refusal("drawing_broken", `the drawing does not load (${loaded.errors.map(formatIssue).slice(0, 3).join("; ")}); run plannotator system check`);
  }
  let result;
  try {
    result = await gateRepo({ root, from, to, model: loaded.model });
  } catch (e) {
    throw new Refusal("git_failed", firstLine((e as Error).message));
  }
  await out(JSON.stringify(result));
  return 0;
}

function keyOf(f: Flags): string {
  const key = required(f, "--key");
  try {
    return checkKey(key);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

function projectFolder(deps: SystemCommandDeps, f: Flags): string {
  const flag = required(f, "--project");
  const root = resolve(deps.cwd, flag);
  if (!isDir(root)) throw new Refusal("not_a_folder", `--project ${flag}: no such folder`);
  return root;
}

async function runTick(argv: readonly string[], deps: SystemCommandDeps, out: (text: string) => Promise<void>): Promise<number> {
  const f = parseFlags(argv, ["--project", "--key"]);
  noWords(f, "tick");
  const key = keyOf(f);
  const root = projectFolder(deps, f);
  const result = await tick({ root, dataDir: resolve(deps.dataDir), key, ...(deps.now ? { now: deps.now } : {}), deps: { ...(deps.self.length === 1 ? { plannotator: deps.self[0]! } : {}), ...deps.tick } });
  if (result.ran === "failed") throw new Refusal("tick_failed", result.error ?? "the tick failed");
  await out(JSON.stringify(result));
  return 0;
}

/** `host/owner/repo#n`: each part a plain name, n a pull request number. */
function parsePr(value: string): { repo: string; segments: [string, string, string]; n: number } {
  const m = /^([^/#\s]+)\/([^/#\s]+)\/([^/#\s]+)#([1-9][0-9]{0,9})$/.exec(value);
  if (!m || [m[1], m[2], m[3]].some((s) => s === "." || s === "..")) throw new UsageError(`--pr takes <host>/<owner>/<repo>#<n>, for example github.com/acme/app#12, not "${value}"`);
  return { repo: `${m[1]}/${m[2]}/${m[3]}`, segments: [m[1]!, m[2]!, m[3]!], n: Number(m[4]) };
}

/** The drawing as the Inbox shows it to a teammate: committed on the default branch. */
async function defaultBranchRef(root: string): Promise<string> {
  const git = async (args: string[]) => {
    const proc = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? text.trim() : null;
  };
  const head = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (head) return head;
  for (const b of ["main", "master"]) if (await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b}^{commit}`])) return `refs/remotes/origin/${b}`;
  return "HEAD";
}

async function runRevision(argv: readonly string[], deps: SystemCommandDeps, out: (text: string) => Promise<void>, err: (text: string) => void): Promise<number> {
  const f = parseFlags(argv, ["--project", "--pr", "--head"]);
  if (f.words.length !== 1 || f.words[0] !== "-") throw new UsageError("revision reads the YAML on stdin: end the command with -");
  const root = projectFolder(deps, f);
  const pr = parsePr(required(f, "--pr"));
  const head = required(f, "--head");
  if (!/^[0-9a-f]{7,64}$/i.test(head)) throw new UsageError(`--head takes the pull request's head commit as a sha, not "${head}"`);

  const ref = await defaultBranchRef(root);
  let committed;
  try {
    committed = await loadCommitted({ root, ref });
  } catch (e) {
    throw new Refusal("git_failed", firstLine((e as Error).message));
  }
  if (!committed.model) {
    if (!committed.errors.length) throw new Refusal("no_drawing", `no drawing committed at ${ref.replace(/^refs\/remotes\//, "")} in ${root}`);
    throw new Refusal("drawing_broken", `the drawing at ${ref.replace(/^refs\/remotes\//, "")} does not load; run plannotator system check`);
  }
  const read = deps.stdin ?? readStdin;
  const yaml = await read(MAX_FILE_BYTES);
  if (yaml === null) throw new Refusal("revision_refused", `the revision is more than ${MAX_FILE_BYTES} bytes`);
  if (!yaml.trim()) throw new Refusal("revision_refused", "stdin is empty: pipe the revision's YAML in");

  const parsed = parseRevision(committed.model, yaml);
  const problems: LoadIssue[] = [...parsed.errors];
  const revision = parsed.revision;
  if (revision) {
    if (revision.pr !== pr.n) problems.push({ file: "revision", field: "pr", message: revision.pr === null ? `is missing; this pull request is ${pr.n}` : `is ${revision.pr}; --pr says ${pr.n}` });
    if (revision.repo !== pr.repo) problems.push({ file: "revision", field: "repo", message: revision.repo ? `is ${revision.repo}; --pr says ${pr.repo}` : `is missing; --pr says ${pr.repo}` });
  }
  if (problems.length || !revision) {
    for (const p of problems) err(`revision_refused: ${formatIssue(p)}`);
    return 1;
  }

  // stored anyway: the renderer narrows the parts to fit
  for (const w of overfullPlacements(committed.model, revision)) err(`warning: ${formatIssue(w)}`);

  const project = await resolveInboxProjectRoot(root);
  // the Inbox's own key for this folder, as the Shape store files under it
  const key = inboxProjectKey(project.name, project.root);
  const dir = join(systemPaths(resolve(deps.dataDir), key).reviews, ...pr.segments);
  const sha7 = head.slice(0, 7).toLowerCase();
  const path = join(dir, `${pr.n}@${sha7}.yaml`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, yaml, { mode: 0o600 });
  await rename(tmp, path);
  // exactly the fields the approved help lists
  await out(JSON.stringify({ stored: path, revision: revision.id, pr: `${pr.repo}#${pr.n}`, head: head.toLowerCase() }));
  return 0;
}

async function runSchedule(argv: readonly string[], deps: SystemCommandDeps, out: (text: string) => Promise<void>): Promise<number> {
  const [op, ...rest] = argv;
  const o = deps.schedule ?? {};
  if (op === "list") {
    noWords(parseFlags(rest, []), "schedule list");
    await out(JSON.stringify(await schedule.list(o.agentsDir ? { agentsDir: o.agentsDir } : {})));
    return 0;
  }
  if (op === "remove") {
    const f = parseFlags(rest, ["--key"]);
    noWords(f, "schedule remove");
    const key = keyOf(f);
    await launchd(() => schedule.remove(key, o));
    await out(JSON.stringify({ removed: key, label: schedule.label(key) }));
    return 0;
  }
  if (op === "install") {
    const f = parseFlags(rest, ["--project", "--key"]);
    noWords(f, "schedule install");
    const key = keyOf(f);
    const root = projectFolder(deps, f);
    // the plist runs `<program> system tick`: one binary, never `bun <script>`
    const program = deps.self.length === 1 ? deps.self[0]! : null;
    if (!program || !isAbsolute(program)) {
      throw new Refusal("not_installed", "schedule install writes a launchd job that runs the installed plannotator binary; run it from the installed plannotator, not from a source checkout");
    }
    const dataDir = resolve(deps.dataDir);
    // launchd starts a job with almost no environment; the tick runs git, gh and the person's agent
    const env: Record<string, string> = deps.env.PATH ? { PATH: deps.env.PATH } : {};
    await launchd(() => schedule.install({ key, root, program, dataDir, interval: SYSTEM_TICK_INTERVAL_SECONDS, env, ...o }));
    await out(JSON.stringify({ installed: key, label: schedule.label(key), plist: join(o.agentsDir ?? launchAgentsDir(), `${schedule.label(key)}.plist`), interval: SYSTEM_TICK_INTERVAL_SECONDS }));
    return 0;
  }
  throw new UsageError(op ? `schedule takes install, remove or list, not "${op}"` : "schedule takes install, remove or list");
}

/** launchctl's and the platform's refusals, as a failure. */
async function launchd(step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (e) {
    const message = (e as Error).message;
    throw new Refusal(/macOS only/.test(message) ? "unsupported" : "launchctl_failed", message);
  }
}

/** stdin up to `max` bytes as UTF-8; null when there is more. */
async function readStdin(max: number): Promise<string | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = (Bun.stdin.stream() as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Write to stdout and settle once the text is flushed (or the reader is gone). */
const writeStdout = (text: string): Promise<void> => new Promise((done) => void process.stdout.write(`${text}\n`, () => done()));

/** Run one `plannotator system` command; the exit code. */
export async function runSystemCommand(argv: readonly string[], deps: SystemCommandDeps): Promise<number> {
  const out = deps.stdout ?? writeStdout;
  const err = deps.stderr ?? ((text: string) => void process.stderr.write(`${text}\n`));
  const [sub, ...rest] = argv;
  if (sub === undefined || hasHelpFlag([...argv])) {
    await out(SYSTEM_COMMAND_USAGE);
    return 0;
  }
  try {
    if (sub === "check") return await runCheck(rest, deps, out, err);
    if (sub === "gate") return await runGate(rest, deps, out);
    if (sub === "tick") return await runTick(rest, deps, out);
    if (sub === "revision") return await runRevision(rest, deps, out, err);
    if (sub === "schedule") return await runSchedule(rest, deps, out);
    throw new UsageError(`unknown command "${sub}"; plannotator system takes check, gate, tick, revision or schedule`);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`usage: ${e.message}. Run 'plannotator system --help'.`);
      return 2;
    }
    if (e instanceof Refusal) {
      err(`${e.code}: ${e.message}`);
      return 1;
    }
    err(`failed: ${(e as Error).message}`);
    return 1;
  }
}
