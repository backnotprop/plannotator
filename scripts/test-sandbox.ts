/**
 * `bun run test:sandbox <file…> [-- runner flags]`: run the test files you name
 * in a throwaway world, so no test, child or Inbox can reach your real home,
 * data dir, browser, Inbox or agent config. Paths are relative to the repo root
 * (`bun run` starts scripts there).
 *
 * - Refuses an empty list (a bare `bun test` runs the whole suite), a path that is
 *   not a file, the files listed in REFUSED, anything after `--` that is not a
 *   flag (a path or a bare word there would add files: give values as
 *   `--flag=value`), and any argument or PLANNOTATOR_PORT that names 59812 (the
 *   person's Inbox port).
 * - Makes one temp root: `home/` (a seeded `.gitconfig`, scratch XDG, Claude and
 *   Codex folders), `data/` and `tmp/`. The CHILD's env points HOME, TMPDIR,
 *   PLANNOTATOR_DATA_DIR and PLANNOTATOR_TEST_SANDBOX there before it starts, so
 *   Bun's `os.homedir()` (fixed at startup), `$HOME` and every grandchild agree.
 *   This process keeps its own env.
 * - Opens no browser (PLANNOTATOR_BROWSER from tests/helpers/no-browser.ts), sends
 *   no ping or feedback, connects no agents. Drops the calling agent's markers
 *   (every variable apps/hook/server/detect-origin.ts reads, its session
 *   variables), SSH_* and PLANNOTATOR_REMOTE (remote mode), and GIT_DIR and its
 *   kin (a test's temp-repo git would act on the outer repo).
 *   PLAYWRIGHT_BROWSERS_PATH keeps pointing at the real browser cache, by path.
 * - `tests/e2e/*.spec.ts` run under Playwright (tests/e2e/playwright.config.ts);
 *   the files tests/dom-test-list.txt lists under `DOM_TESTS=1 --isolate`, and
 *   those CI runs in its own-process DOM steps under `DOM_TESTS=1` (each alone;
 *   CI runs a step's files together); the rest under one `bun test`. A file that
 *   needs happy-dom but is in neither place is refused (every test in it would
 *   skip, green). Runs go from the repo root,
 *   so the root bunfig preload always loads.
 * - A stop signal reaches the running child once, then SIGKILL follows if it
 *   does not exit (see runSandbox); no further run starts and teardown still runs.
 * - Teardown stops only the Inboxes it can prove the root started
 *   (tests/helpers/inbox-process.ts), fails when any registry under the root
 *   names port 59812 (never contacted, never signalled), and removes the root.
 *
 * scripts/test-sandbox.test.ts proves the refusals, the child's env, the routing
 * and the teardown with stand-in runners.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { NO_BROWSER } from "../tests/helpers/no-browser";
import { DOM_GATE_SELF, DOM_LIST, domListFiles, isDomGated, ownProcessDomStepFiles, WORKFLOW } from "./dom-gating";
import { accountHome, isScratchDataDir } from "../tests/helpers/real-data-dir";

export const REPO_ROOT = resolve(import.meta.dir, "..");
const OWNER_INBOX_PORT = "59812";
/** Specs another config runs (tests/e2e/playwright.config.ts OWN_CONFIG). */
const OWN_CONFIG_SPECS = new Set(["tests/e2e/inbox-thread-parity.spec.ts"]);
const E2E_SPEC = /^tests\/e2e\/[^/]+\.spec\.ts$/;

/** Files this command does not run: each starts something real on purpose. */
const REFUSED: Record<string, string> = {
  "apps/pi-extension/inbox.test.ts": "starts the installed Pi agent; run it on purpose, not through test:sandbox",
  "tests/never-touch-the-real-inbox.test.ts": "starts Inbox servers to prove the real-Inbox guards; run it on purpose, not through test:sandbox",
};

/** Variables from the caller that would point a child at real config, remote mode, an outer git repo or the calling agent's own session. */
const DROPPED = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PROJECT_DIR|CODEX_.*|OPENCODE.*|PI_.*|QWEN_CODE.*|DSH_.*|T3CODE_.*|VIBE_HOME|COPILOT_HOME|QWEN_HOME|FACTORY_CONFIG_DIR|GEMINI_CLI_HOME|SSH_.*|GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_COMMON_DIR|GIT_CONFIG_GLOBAL|DOM_TESTS|PLANNOTATOR_PORT|PLANNOTATOR_LIVE_PORT|PLANNOTATOR_REMOTE|PLANNOTATOR_HOST_.*|PLANNOTATOR_SESSION_.*|PLANNOTATOR_INBOX_REMINDER)$/;

/**
 * Every variable apps/hook/server/detect-origin.ts reads to tell which agent
 * called (`env.NAME`, `env["NAME"]`, and the quoted names in its marker lists),
 * read from the source so a new agent's marker is dropped too. Throws when it
 * finds too few to be the real list.
 */
export function originMarkers(source = readFileSync(join(REPO_ROOT, "apps/hook/server/detect-origin.ts"), "utf8")): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/\benv(?:\.([A-Z][A-Z0-9_]*)|\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\])/g)) names.add((m[1] ?? m[2])!);
  for (const list of source.matchAll(/=\s*\[([^\]]*)\]\s*as const/g)) for (const m of list[1]!.matchAll(/["']([A-Z][A-Z0-9_]*)["']/g)) names.add(m[1]!);
  if (names.size < 8) throw new Error(`test-sandbox: found only ${names.size} agent markers in detect-origin.ts; refusing to run with a short list`);
  return [...names].sort();
}

export class SandboxRefusal extends Error {}

export interface SandboxArgs {
  /** Paths relative to the repo root, `/`-separated. */
  files: string[];
  passthrough: string[];
}

/** The files before `--` and the runner flags after it, after every refusal. */
export function parseSandboxArgs(argv: readonly string[], cwd: string, env: Readonly<Record<string, string | undefined>> = process.env): SandboxArgs {
  const split = argv.indexOf("--");
  const named = split < 0 ? [...argv] : argv.slice(0, split);
  const passthrough = split < 0 ? [] : argv.slice(split + 1);
  if ([...argv, env.PLANNOTATOR_PORT ?? ""].some((value) => new RegExp(`\\b${OWNER_INBOX_PORT}\\b`).test(value))) {
    throw new SandboxRefusal(`refusing port ${OWNER_INBOX_PORT}: it is the person's Inbox (check the arguments and PLANNOTATOR_PORT)`);
  }
  const flag = named.find((arg) => arg.startsWith("-"));
  if (flag) throw new SandboxRefusal(`${flag}: put runner flags after \`--\` (bun run test:sandbox <file…> -- ${flag})`);
  // The runners read any other word as a file or a filter that adds files (a trailing `./` runs the whole suite).
  const positional = passthrough.find((arg) => !arg.startsWith("-"));
  if (positional !== undefined) {
    throw new SandboxRefusal(`${positional || '""'}: after \`--\` only runner flags, with values as --flag=value (e.g. --test-name-pattern=name); name files before \`--\``);
  }
  // Another config would swap the e2e config (the parity spec's own) or the bunfig preload that sandboxes bun tests.
  const config = passthrough.find((arg) => /^(-c|--config)(=|$)/.test(arg));
  if (config) throw new SandboxRefusal(`${config}: this command picks the config itself`);
  if (named.length === 0) throw new SandboxRefusal("name the test files to run; refusing an empty list, which would run the whole suite");
  const domFiles = new Set([...domListFiles(), ...ownProcessDomStepFiles()]);
  const files = named.map((arg) => {
    const path = resolve(cwd, arg);
    let isFile = false;
    try {
      isFile = statSync(path).isFile();
    } catch {
      // Missing.
    }
    if (!isFile) throw new SandboxRefusal(`not a file: ${arg}`);
    const rel = relative(REPO_ROOT, realpathSync(path));
    if (rel.startsWith("..") || isAbsolute(rel)) throw new SandboxRefusal(`${arg} is outside this repository`);
    const file = rel.split(sep).join("/");
    if (REFUSED[file]) throw new SandboxRefusal(`${file} ${REFUSED[file]}`);
    if (OWN_CONFIG_SPECS.has(file)) throw new SandboxRefusal(`${file} runs under its own config: bun run test:parity:inbox-thread`);
    if (file.startsWith("tests/e2e/") && !E2E_SPEC.test(file)) throw new SandboxRefusal(`${file} is not a tests/e2e/*.spec.ts spec`);
    if (!E2E_SPEC.test(file) && !domFiles.has(file) && !DOM_GATE_SELF.has(file) && isDomGated(readFileSync(join(REPO_ROOT, file), "utf8"))) {
      throw new SandboxRefusal(`${file} needs happy-dom but is in neither ${DOM_LIST} nor a DOM step of ${WORKFLOW}: add it to ${DOM_LIST}, or every test in it skips, here and in CI`);
    }
    return file;
  });
  return { files, passthrough };
}

const mk = (...parts: string[]) => {
  const dir = join(...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** Where Playwright keeps its browsers when PLAYWRIGHT_BROWSERS_PATH is unset (a path; nothing is read there). */
function playwrightCache(env: Readonly<Record<string, string | undefined>>, realHome: string): string {
  if (process.platform === "win32") return join(env.LOCALAPPDATA ?? join(realHome, "AppData", "Local"), "ms-playwright");
  if (process.platform === "darwin") return join(realHome, "Library", "Caches", "ms-playwright");
  return join(env.XDG_CACHE_HOME || join(realHome, ".cache"), "ms-playwright");
}

export interface Sandbox {
  root: string;
  home: string;
  env: Record<string, string>;
}

/** A new root and the env every child runs with. Throws rather than hand a child anything but the scratch home. */
export function makeSandbox(parentEnv: Readonly<Record<string, string | undefined>> = process.env): Sandbox {
  // Before the root exists, so a failure here leaves nothing behind.
  const markers = new Set(originMarkers());
  // /tmp on POSIX: shorter than macOS's per-user temp dir, so socket paths under TMPDIR stay short.
  const root = realpathSync(mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "plannotator-sbx-")));
  const realHome = accountHome();
  const home = mk(root, "home");
  if (!isScratchDataDir(home) || (realHome && resolve(home) === resolve(realHome))) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`test-sandbox: ${home} is not a scratch folder; refusing to run`);
  }
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Sandbox Test\n\temail = sandbox@example.com\n[init]\n\tdefaultBranch = main\n");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) if (value !== undefined && !DROPPED.test(key) && !markers.has(key)) env[key] = value;
  Object.assign(env, {
    HOME: home,
    ...(process.platform === "win32" ? { USERPROFILE: home } : {}),
    TMPDIR: mk(root, "tmp"),
    PLANNOTATOR_DATA_DIR: mk(root, "data"),
    PLANNOTATOR_TEST_SANDBOX: root,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_ANON_PING: "1",
    PLANNOTATOR_FEEDBACK_URL: "http://127.0.0.1:9/feedback",
    PLANNOTATOR_INBOX_CONNECT: "0",
    XDG_CONFIG_HOME: mk(home, ".config"),
    XDG_DATA_HOME: mk(home, ".local", "share"),
    XDG_CACHE_HOME: mk(home, ".cache"),
    XDG_STATE_HOME: mk(home, ".local", "state"),
    CLAUDE_CONFIG_DIR: mk(home, ".claude"),
    CODEX_HOME: mk(home, ".codex"),
    PLAYWRIGHT_BROWSERS_PATH: parentEnv.PLAYWRIGHT_BROWSERS_PATH || playwrightCache(parentEnv, realHome ?? home),
  });
  return { root, home, env };
}

export interface Run {
  argv: string[];
  env: Record<string, string>;
}

export interface Runners {
  bun: string;
  playwright: string;
}

/** The runs, in order: plain bun tests, the listed DOM files, each file of CI's own-process DOM steps, then the e2e specs. */
export function planRuns(args: SandboxArgs, env: Record<string, string>, runners: Runners): Run[] {
  const e2e = args.files.filter((f) => E2E_SPEC.test(f));
  const rest = args.files.filter((f) => !e2e.includes(f));
  const listed = new Set(domListFiles());
  const dom = rest.filter((f) => listed.has(f));
  const ownSteps = new Set(ownProcessDomStepFiles());
  const ownProcessDom = rest.filter((f) => !listed.has(f) && ownSteps.has(f));
  const plain = rest.filter((f) => !dom.includes(f) && !ownProcessDom.includes(f));
  const domEnv = { ...env, DOM_TESTS: "1" };
  const bunTest = (files: string[], flags: string[] = []) => [runners.bun, "test", ...flags, ...files.map((f) => `./${f}`), ...args.passthrough];
  const runs: Run[] = [];
  if (plain.length > 0) runs.push({ argv: bunTest(plain), env });
  if (dom.length > 0) runs.push({ argv: bunTest(dom, ["--isolate"]), env: domEnv });
  for (const file of ownProcessDom) runs.push({ argv: bunTest([file]), env: domEnv });
  if (e2e.length > 0) runs.push({ argv: [runners.playwright, "test", "-c", "tests/e2e/playwright.config.ts", ...e2e, ...args.passthrough], env });
  return runs;
}

/** Every `inbox/inbox.json` under `dir`. */
function registriesUnder(dir: string, depth = 8, found: string[] = []): string[] {
  if (depth < 0) return found;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(dir, entry.name);
    if (entry.name === "inbox" && existsSync(join(path, "inbox.json"))) found.push(join(path, "inbox.json"));
    registriesUnder(path, depth - 1, found);
  }
  return found;
}

/**
 * Stop the Inboxes the root provably started, then remove the root. Returns the
 * registries that name the person's port: those are reported, never contacted.
 */
export async function teardown(root: string): Promise<string[]> {
  const owner: string[] = [];
  const registries = registriesUnder(root);
  if (registries.length > 0) {
    // Imported here: its data-dir sandbox would otherwise run in this process on every start.
    const { readInboxEntry, stopProvenInboxes } = await import("../tests/helpers/inbox-process");
    const targets: { entry: NonNullable<ReturnType<typeof readInboxEntry>>; root: string }[] = [];
    for (const file of registries) {
      const text = readFileSync(file, "utf8");
      const entry = readInboxEntry(file);
      if (entry?.port === Number(OWNER_INBOX_PORT) || new RegExp(`"port"\\s*:\\s*${OWNER_INBOX_PORT}\\b`).test(text)) owner.push(file);
      else if (entry) targets.push({ entry, root });
    }
    await stopProvenInboxes(targets);
  }
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    process.stderr.write(`test-sandbox: could not remove ${root}: ${(error as Error).message}\n`);
  }
  return owner;
}

/** Where the stop signals come from (the process; a test passes its own), and how long a child gets to stop. */
export interface SandboxOptions {
  signals?: Pick<NodeJS.EventEmitter, "on" | "off">;
  graceMs?: number;
}

/**
 * Run `args` in a fresh sandbox; resolves to the exit code.
 *
 * A stop (a harness may signal only this pid): SIGTERM or SIGHUP sends the
 * running child SIGTERM, then SIGKILL `graceMs` later if it is still alive.
 * SIGINT is not passed on at once, because a terminal Ctrl-C already reached
 * the child (same process group) and a second one makes Playwright skip its
 * cleanup; SIGTERM follows `graceMs` later only if the child is still running.
 * A second signal kills the child at once. No later run starts. The handlers
 * stay until teardown ends, so another signal cannot stop this process halfway.
 */
export async function runSandbox(
  args: SandboxArgs,
  runners: Runners,
  parentEnv: Readonly<Record<string, string | undefined>> = process.env,
  options: SandboxOptions = {},
): Promise<number> {
  const source = options.signals ?? process;
  const graceMs = options.graceMs ?? 5_000;
  const sandbox = makeSandbox(parentEnv);
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let stopped = false;
  let signalsSeen = 0;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const send = (signal: NodeJS.Signals) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  };
  const terminate = () => {
    send("SIGTERM");
    timers.push(setTimeout(() => send("SIGKILL"), graceMs));
  };
  const onSignal = (signal: NodeJS.Signals) => {
    stopped = true;
    if (++signalsSeen > 1) return send("SIGKILL");
    if (signal === "SIGINT") timers.push(setTimeout(terminate, graceMs));
    else terminate();
  };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) source.on(signal, onSignal);
  let code = 0;
  try {
    for (const run of planRuns(args, sandbox.env, runners)) {
      if (stopped) break;
      child = Bun.spawn(run.argv, { cwd: REPO_ROOT, env: run.env, stdio: ["inherit", "inherit", "inherit"] });
      const exit = await child.exited;
      child = null;
      if (exit !== 0 && code === 0) code = exit;
    }
    if (stopped && code === 0) code = 1;
  } finally {
    for (const timer of timers) clearTimeout(timer);
    try {
      const owner = await teardown(sandbox.root);
      for (const file of owner) process.stderr.write(`test-sandbox: ${relative(sandbox.root, file)} names port ${OWNER_INBOX_PORT}, the person's Inbox. Not contacted; failing the run.\n`);
      if (owner.length > 0) code = 3;
    } finally {
      for (const signal of signals) source.off(signal, onSignal);
    }
  }
  return code;
}

function defaultRunners(): Runners {
  const playwright = join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "playwright.exe" : "playwright");
  return { bun: process.execPath, playwright };
}

if (import.meta.main) {
  try {
    const args = parseSandboxArgs(process.argv.slice(2), process.cwd());
    const runners = defaultRunners();
    if (args.files.some((f) => f.startsWith("tests/e2e/")) && !existsSync(runners.playwright)) throw new SandboxRefusal(`no Playwright at ${runners.playwright}: run bun install`);
    process.exit(await runSandbox(args, runners));
  } catch (error) {
    if (!(error instanceof SandboxRefusal)) throw error;
    process.stderr.write(`test-sandbox: ${error.message}\n`);
    process.exit(2);
  }
}
