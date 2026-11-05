/**
 * `bun run test:sandbox <file…> [-- runner flags]`: run the test files you name
 * in a throwaway world, so no test, child or Inbox can reach your real home,
 * data dir, browser, Inbox or agent config.
 *
 * - Refuses an empty list (a bare `bun test` runs the whole suite), a path that is
 *   not a file, and any argument or PLANNOTATOR_PORT that names 59812 (the
 *   person's Inbox port).
 * - Makes one temp root: `home/` (a seeded `.gitconfig`, scratch XDG, Claude and
 *   Codex folders), `data/` and `tmp/`. The CHILD's env points HOME, TMPDIR,
 *   PLANNOTATOR_DATA_DIR and PLANNOTATOR_TEST_SANDBOX there before it starts, so
 *   Bun's `os.homedir()` (fixed at startup), `$HOME` and every grandchild agree.
 *   This process keeps its own env.
 * - Opens no browser (PLANNOTATOR_BROWSER from tests/helpers/no-browser.ts), sends
 *   no ping or feedback, connects no agents, checks no updates, offers no notes.
 *   The calling agent's session variables are dropped, as on CI.
 *   PLAYWRIGHT_BROWSERS_PATH keeps pointing at the real browser cache, by path.
 * - `tests/e2e/*.spec.ts` run under Playwright (tests/e2e/playwright.config.ts);
 *   DOM-gated files under `DOM_TESTS=1` (with `--isolate` when
 *   tests/dom-test-list.txt lists them, each in its own process when it does not,
 *   as CI runs them); the rest under one `bun test`. Runs go from the repo root,
 *   so the root bunfig preload always loads.
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
import { accountHome, isScratchDataDir } from "../tests/helpers/real-data-dir";

export const REPO_ROOT = resolve(import.meta.dir, "..");
const OWNER_INBOX_PORT = "59812";
const DOM_LIST = "tests/dom-test-list.txt";
/** Specs another config runs (tests/e2e/playwright.config.ts OWN_CONFIG). */
const OWN_CONFIG_SPECS = new Set(["tests/e2e/inbox-thread-parity.spec.ts"]);
const E2E_SPEC = /^tests\/e2e\/[^/]+\.spec\.ts$/;

/** Variables from the caller that would point a child at real config or at the calling agent's own session. */
const DROPPED = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PROJECT_DIR|CODEX_.*|OPENCODE.*|PI_.*|VIBE_HOME|COPILOT_HOME|QWEN_HOME|FACTORY_CONFIG_DIR|DSH_HOME|GEMINI_CLI_HOME|GIT_CONFIG_GLOBAL|DOM_TESTS|PLANNOTATOR_PORT|PLANNOTATOR_SESSION_.*|PLANNOTATOR_INBOX_REMINDER)$/;

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
  if (named.length === 0) throw new SandboxRefusal("name the test files to run; refusing an empty list, which would run the whole suite");
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
    if (OWN_CONFIG_SPECS.has(file)) throw new SandboxRefusal(`${file} runs under its own config: bun run test:parity:inbox-thread`);
    if (file.startsWith("tests/e2e/") && !E2E_SPEC.test(file)) throw new SandboxRefusal(`${file} is not a tests/e2e/*.spec.ts spec`);
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
  for (const [key, value] of Object.entries(parentEnv)) if (value !== undefined && !DROPPED.test(key)) env[key] = value;
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
    PLANNOTATOR_UPDATE_CHECK: "0",
    PLANNOTATOR_INBOX_NOTES: "0",
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

/** A file that skips itself without happy-dom (the rule scripts/dom-test-allowlist.test.ts applies). */
function isDomGated(file: string): boolean {
  const source = readFileSync(join(REPO_ROOT, file), "utf8");
  return /\b(describe|test|it)\.(if|skipIf)\(!?hasDom\)/.test(source) || /DOM_TESTS/.test(source);
}

function domList(): Set<string> {
  return new Set(
    readFileSync(join(REPO_ROOT, DOM_LIST), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#")),
  );
}

export interface Run {
  argv: string[];
  env: Record<string, string>;
}

export interface Runners {
  bun: string;
  playwright: string;
}

/** The runs, in order: plain bun tests, the listed DOM files, each unlisted DOM file, then the e2e specs. */
export function planRuns(args: SandboxArgs, env: Record<string, string>, runners: Runners): Run[] {
  const e2e = args.files.filter((f) => E2E_SPEC.test(f));
  const rest = args.files.filter((f) => !e2e.includes(f));
  const listed = domList();
  const dom = rest.filter((f) => listed.has(f));
  const ownProcessDom = rest.filter((f) => !listed.has(f) && isDomGated(f));
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
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return owner;
}

/** Run `args` in a fresh sandbox; resolves to the exit code. */
export async function runSandbox(args: SandboxArgs, runners: Runners, parentEnv: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  const sandbox = makeSandbox(parentEnv);
  // Ctrl-C reaches the runner too (same process group); this process waits for it, then tears down.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  process.on("SIGTERM", ignore);
  let code = 0;
  try {
    for (const run of planRuns(args, sandbox.env, runners)) {
      const child = Bun.spawn(run.argv, { cwd: REPO_ROOT, env: run.env, stdio: ["inherit", "inherit", "inherit"] });
      const exit = await child.exited;
      if (exit !== 0 && code === 0) code = exit;
    }
  } finally {
    process.off("SIGINT", ignore);
    process.off("SIGTERM", ignore);
    const owner = await teardown(sandbox.root);
    for (const file of owner) process.stderr.write(`test-sandbox: ${relative(sandbox.root, file)} names port ${OWNER_INBOX_PORT}, the person's Inbox. Not contacted; failing the run.\n`);
    if (owner.length > 0) code = 3;
  }
  return code;
}

function defaultRunners(): Runners {
  const playwright = join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "playwright.exe" : "playwright");
  return { bun: process.execPath, playwright };
}

if (import.meta.main) {
  try {
    const args = parseSandboxArgs(process.argv.slice(2), process.env.INIT_CWD || process.cwd());
    const runners = defaultRunners();
    if (args.files.some((f) => f.startsWith("tests/e2e/")) && !existsSync(runners.playwright)) throw new SandboxRefusal(`no Playwright at ${runners.playwright}: run bun install`);
    process.exit(await runSandbox(args, runners));
  } catch (error) {
    if (!(error instanceof SandboxRefusal)) throw error;
    process.stderr.write(`test-sandbox: ${error.message}\n`);
    process.exit(2);
  }
}
