/**
 * Tests and dev scripts can never reach the person's real Inbox or data dir.
 *
 * Two halves:
 *
 *  1. A source scan of every test and dev script (tests/helpers/real-inbox-scan.ts).
 *     It fails on
 *     - a signal in a file that handles Inbox processes or registries,
 *       outside tests/helpers/inbox-process.ts (the one place that signals,
 *       and only once the pid is proven to be the Inbox that test started):
 *       `process.kill` with any signal but 0, `kill`/`pkill`/`killall` through
 *       spawn/exec or in a shell string, `kill` taken off `process`;
 *     - a path from the home directory to `.plannotator` (same line, a
 *       multi-line join, a variable assigned from `homedir()`, the literal
 *       "~/.plannotator" used as a path), outside tests/helpers/real-data-dir.ts;
 *     - a `startInboxServer(...)` call that does not name its `dataDir`, or a
 *       script that starts one without pointing PLANNOTATOR_DATA_DIR at it;
 *     - a path from the real home directory to an agent's own folder
 *       (`~/.codex`, `~/.cursor`, `~/.config/opencode`, the Claude app's
 *       settings…), or connecting agents with no agent environment (it would
 *       run the real agent CLIs against the real home).
 *  2. The guards themselves: the real data dir (default or relocated) is
 *     refused however it is spelled, the import-time sandbox replaces it with
 *     a temp folder with no bunfig at all, and a pid that is not provably the
 *     test's Inbox is never signalled.
 *
 * Never reads, writes or signals anything under the real data dir: the
 * refusals are checked as path arithmetic and through child processes that
 * exit before touching it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { provenInbox, signalProvenInbox } from "./helpers/inbox-process";
import { accountHome as accountHomeOf, isRealDataDir, isScratchDataDir, realDataDirs, refuseRealDataDir } from "./helpers/real-data-dir";
import { agentConnectFindings, agentHomeFindings, homePathFindings, inboxServerFindings, OWN_CHILD_MARK, signalFindings } from "./helpers/real-inbox-scan";

const repoRoot = resolve(import.meta.dir, "..");

// ── 1. The source scan ───────────────────────────────────────────────────────

/** Folders never scanned: dependencies, build output, git metadata and worktrees, the pre-monorepo reference code. */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", ".claude", ".local", "legacy", "coverage", "playwright-report", "test-results"]);

/** A test or dev-script source: a *.test / *.spec file anywhere, or any script under tests/, scripts/ or a testing/ folder. */
function isTestOrScript(rel: string): boolean {
  if (!/\.(?:ts|tsx|mts|js|mjs)$/.test(rel)) return false;
  if (/\.(?:test|spec)\.(?:ts|tsx|mts|js|mjs)$/.test(rel)) return true;
  return /^(?:tests|scripts)\//.test(rel) || /(?:^|\/)(?:testing|test-setup|test-fixtures)\//.test(rel);
}

function sources(dir = repoRoot, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      sources(join(dir, entry.name), found);
    } else if (entry.isFile()) {
      const rel = relative(repoRoot, join(dir, entry.name)).split("\\").join("/");
      if (isTestOrScript(rel)) found.push(rel);
    }
  }
  return found;
}

/** The scan's own module and this file hold its fixtures (regexes and strings); everything else is scanned. */
const SCANNER_FILES = new Set(["tests/helpers/real-inbox-scan.ts", "tests/never-touch-the-real-inbox.test.ts"]);
const SIGNAL_ALLOWED = new Set(["tests/helpers/inbox-process.ts", ...SCANNER_FILES]);
const HOME_PATH_ALLOWED = new Set(["tests/helpers/real-data-dir.ts", ...SCANNER_FILES]);
/** vibe-plan.test.ts only compares the default it resolves (~/.vibe/plans) with the expected path; it reads and writes nothing there. */
const AGENT_HOME_ALLOWED = new Set(["apps/hook/server/vibe-plan.test.ts", ...SCANNER_FILES]);

const isStandaloneScript = (rel: string) => !/\.(?:test|spec)\.(?:ts|tsx|mts|js|mjs)$/.test(rel);

describe("the source scan", () => {
  const files = sources();
  const read = (file: string) => readFileSync(join(repoRoot, file), "utf8");
  const collect = (allowed: Set<string>, scan: (text: string, file: string) => string[]) =>
    files.filter((file) => !allowed.has(file)).flatMap((file) => scan(read(file), file).map((finding) => `${file}:${finding}`));

  test("finds the test and script sources it guards", () => {
    // Sentinels: if the walk stops reaching these, the scan proves nothing.
    for (const known of ["tests/helpers/inbox-world.ts", "tests/e2e/inbox-scratch.ts", "apps/hook/server/inbox-cli.test.ts", "scripts/dast/target.ts", "scripts/inbox-sim.ts"]) {
      expect(files).toContain(known);
    }
  });

  test("no raw signal to an Inbox pid outside tests/helpers/inbox-process.ts", () => {
    // Use signalInbox / stopInbox (tests/helpers/inbox-world.ts), stopScratchInbox
    // (tests/e2e/inbox-scratch.ts) or the inbox-process helpers instead; a test's
    // own non-Inbox child may be marked with OWN_CHILD_MARK on the line.
    expect(collect(SIGNAL_ALLOWED, (text) => signalFindings(text))).toEqual([]);
  });

  test("no path from the home directory to .plannotator outside tests/helpers/real-data-dir.ts", () => {
    expect(collect(HOME_PATH_ALLOWED, (text) => homePathFindings(text))).toEqual([]);
  });

  test("every startInboxServer call names its dataDir, and a script points PLANNOTATOR_DATA_DIR at it (config.json follows the env)", () => {
    expect(collect(SCANNER_FILES, (text, file) => inboxServerFindings(text, isStandaloneScript(file)))).toEqual([]);
  });

  test("no path from the real home to an agent's own folder, and no agent connection without a scratch environment", () => {
    expect(collect(AGENT_HOME_ALLOWED, (text) => agentHomeFindings(text))).toEqual([]);
    expect(collect(SCANNER_FILES, (text) => agentConnectFindings(text))).toEqual([]);
  });

  test("the scan catches what it is for (fixtures in memory, not on disk)", () => {
    const inboxFile = (body: string) => `const { pid } = JSON.parse(readFileSync(join(dataDir, "inbox", "inbox.json"), "utf8"));\n${body}\n`;
    // Signals.
    expect(signalFindings(inboxFile('process.kill(pid, "SIGKILL");'))).toHaveLength(1);
    expect(signalFindings(inboxFile("process.kill(pid);"))).toHaveLength(1);
    expect(signalFindings(inboxFile("process.kill(pid, 0);"))).toEqual([]);
    expect(signalFindings(inboxFile("execSync(`kill -9 ${pid}`);"))).not.toEqual([]);
    expect(signalFindings(inboxFile('spawnSync("kill", [String(pid)]);'))).not.toEqual([]);
    expect(signalFindings(inboxFile('Bun.spawnSync(["pkill", "-f", "plannotator inbox"]);'))).not.toEqual([]);
    expect(signalFindings(inboxFile("const { kill } = process;\nkill(pid, 9);"))).not.toEqual([]);
    expect(signalFindings(inboxFile("const stop = process.kill;"))).not.toEqual([]);
    expect(signalFindings(inboxFile('// kill -9 the old one, process.kill(pid, "SIGKILL")'))).toEqual([]);
    expect(signalFindings(inboxFile('child.kill("SIGKILL");'))).toEqual([]);
    expect(signalFindings(inboxFile(`// ${OWN_CHILD_MARK}\nprocess.kill(child.pid, "SIGKILL");`))).toEqual([]);
    expect(signalFindings('process.kill(child.pid, "SIGKILL");')).toEqual([]); // Not an Inbox file.
    // Home paths.
    expect(homePathFindings('const dir = join(homedir(), ".plannotator", "inbox");')).toHaveLength(1);
    expect(homePathFindings('const dir = join(\n  homedir(),\n  ".plannotator",\n);')).toHaveLength(1);
    expect(homePathFindings('const home = homedir();\nconst dir = join(home, ".plannotator");')).toHaveLength(1);
    expect(homePathFindings("const home = os.homedir();\nconst dir = `${home}/.plannotator/inbox`;")).toHaveLength(1);
    expect(homePathFindings('process.env.PLANNOTATOR_DATA_DIR = "~/.plannotator";')).toHaveLength(1);
    expect(homePathFindings("expect(text).toContain('~/.plannotator/update.log');")).toEqual([]); // Shown, not used.
    expect(homePathFindings('const dir = join(homedir(), ".plannotator-resolve-file-");')).toEqual([]);
    expect(homePathFindings('const home = join(root, "home");\nconst dir = join(home, ".plannotator");')).toEqual([]);
    expect(homePathFindings("// never ~/.plannotator: join(homedir(), \".plannotator\")")).toEqual([]);
    // Agents' own folders.
    expect(agentHomeFindings('const file = join(homedir(), ".codex", "config.toml");')).toHaveLength(1);
    expect(agentHomeFindings('const home = os.homedir();\nconst file = join(home, ".config", "opencode", "AGENTS.md");')).toHaveLength(1);
    expect(agentHomeFindings('writeFileSync("~/.cursor/mcp.json", "{}");')).toHaveLength(1);
    // Qwen Code's folder holds its settings, session registry and controller tokens.
    expect(agentHomeFindings('const file = join(homedir(), ".qwen", "settings.json");')).toHaveLength(1);
    expect(agentHomeFindings('const file = join(fake.home, ".qwen", "settings.json");')).toEqual([]);
    expect(agentHomeFindings('const file = join(fake.home, ".codex", "config.toml");')).toEqual([]);
    expect(agentConnectFindings('await fetch(`${url}/api/inbox/control/connect`, { method: "POST" });')).toHaveLength(1);
    expect(agentConnectFindings('startInboxServer({ dataDir, agentEnvironment: env });\nawait s.connectAgents();')).toEqual([]);
    // Inbox servers.
    expect(inboxServerFindings('startInboxServer({ version: "x", phones: true })', false)).toHaveLength(1);
    expect(inboxServerFindings('startInboxServer({\n  // dataDir comes later\n  version: "x" })', false)).toHaveLength(1);
    expect(inboxServerFindings("startInboxServer({ dataDir })", false)).toEqual([]);
    expect(inboxServerFindings("startInboxServer({ dataDir })", true)).toHaveLength(1);
    expect(inboxServerFindings("process.env.PLANNOTATOR_DATA_DIR = dataDir;\nstartInboxServer({ dataDir })", true)).toEqual([]);
  });
});

// ── 2. The guards ────────────────────────────────────────────────────────────

const temps: string[] = [];
const children: { kill: (signal?: NodeJS.Signals) => boolean }[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

/** The account's own home (the password database, not $HOME). */
const accountHome = accountHomeOf() ?? homedir();

describe("the real data dir is refused however it is spelled", () => {
  test("~/.plannotator, ~, $HOME, the account's home, a folder inside, and $XDG_DATA_HOME/plannotator", () => {
    for (const dir of ["~/.plannotator", "~/.plannotator/", join(homedir(), ".plannotator"), join(accountHome, ".plannotator"), join(accountHome, ".plannotator", "inbox"), `${homedir()}/./.plannotator/../.plannotator`]) {
      expect(isRealDataDir(dir)).toBe(true);
      expect(() => refuseRealDataDir(dir, "probe")).toThrow(/real Plannotator data directory/);
    }
    if (process.platform === "darwin") expect(isRealDataDir(join(accountHome, ".Plannotator"))).toBe(true);

    const savedXdg = process.env.XDG_DATA_HOME;
    try {
      process.env.XDG_DATA_HOME = "/srv/xdg-probe-data";
      expect(realDataDirs()).toContain(join("/srv/xdg-probe-data", "plannotator"));
      expect(isRealDataDir("/srv/xdg-probe-data/plannotator")).toBe(true);
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = savedXdg;
    }
  });

  test("a symlink to it is refused too; scratch folders and unset are told apart", () => {
    const root = scratch("plannotator-real-data-dir-");
    const link = join(root, "looks-harmless");
    symlinkSync(join(accountHome, ".plannotator"), link);
    expect(isRealDataDir(link)).toBe(true);
    expect(isRealDataDir(join(link, "inbox"))).toBe(true);
    expect(isRealDataDir(join(root, "data"))).toBe(false);
    expect(isRealDataDir(join(accountHome, ".plannotator-other"))).toBe(false);
    expect(refuseRealDataDir(join(root, "data"), "probe")).toBe(join(root, "data"));
    expect(() => refuseRealDataDir(undefined, "probe")).toThrow(/no data directory/);
    expect(() => refuseRealDataDir("  ", "probe")).toThrow(/no data directory/);
  });
});

/** Run `bun <args>` from `cwd` with exactly `env`; resolves with the exit code and output. */
function bun(args: string[], cwd: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    // A guard that let a server start would hang here: end it (our own child).
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("close", () => clearTimeout(timer));
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

describe("the import-time sandbox works with no bunfig", () => {
  const probe = join(repoRoot, "tests", "test-fixtures", "sandbox-probe", "probe.ts");
  const baseEnv = () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? homedir(), TMPDIR: tmpdir() });

  test("PLANNOTATOR_DATA_DIR unset: importing the Inbox helpers sandboxes it in a temp folder", async () => {
    const cwd = scratch("plannotator-no-bunfig-");
    const result = await bun([probe], cwd, baseEnv());
    expect(result.code, result.stderr).toBe(0);
    const dir = result.stdout.trim();
    expect(isScratchDataDir(dir)).toBe(true);
  });

  test("a scratch value (CI's mktemp -d) is kept", async () => {
    const cwd = scratch("plannotator-no-bunfig-");
    const result = await bun([probe], cwd, { ...baseEnv(), PLANNOTATOR_DATA_DIR: join(cwd, "data") });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(join(cwd, "data"));
  });

  test("the real data dir, default or relocated (/custom), is replaced by a temp folder, never used", async () => {
    const cwd = scratch("plannotator-no-bunfig-");
    // The probe only prints: nothing is created or read at these paths.
    const values = ["~/.plannotator", join(accountHome, ".plannotator"), "/opt/plannotator-relocated-data-probe"];
    for (const value of values) {
      const result = await bun([probe], cwd, { ...baseEnv(), PLANNOTATOR_DATA_DIR: value });
      expect(result.code, result.stderr).toBe(0);
      const dir = result.stdout.trim();
      expect(dir).not.toBe(value);
      expect(isScratchDataDir(dir)).toBe(true);
      expect(result.stderr).toContain("is not a scratch folder");
    }
  });

  test("HOME pointed elsewhere does not hide the account's own ~/.plannotator", async () => {
    const cwd = scratch("plannotator-no-bunfig-");
    const value = join(accountHome, ".plannotator");
    const result = await bun([probe], cwd, { ...baseEnv(), HOME: cwd, PLANNOTATOR_DATA_DIR: value });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).not.toBe(value);
    expect(isScratchDataDir(result.stdout.trim())).toBe(true);
  });

  test("the helpers' own check refuses a relocated data dir too", () => {
    expect(isScratchDataDir("/opt/plannotator-relocated-data-probe")).toBe(false);
    expect(() => refuseRealDataDir("/opt/plannotator-relocated-data-probe", "probe")).toThrow(/not a scratch folder/);
    expect(isScratchDataDir(join(tmpdir(), "x", "data"))).toBe(true);
    expect(isScratchDataDir(tmpdir())).toBe(false); // The temp root itself is not a sandbox.
  });

  test("the Inbox dev scripts refuse the default data dir, and DAST refuses none", async () => {
    // These scripts START an Inbox when the guard lets them through, so the
    // proof runs them under a scratch HOME: there, $HOME/.plannotator is the
    // default data dir the guard must refuse, and a broken guard could only
    // ever reach the scratch folder, never the person's. (XDG_DATA_HOME is
    // left out of the env, so the default is $HOME/.plannotator.)
    const cwd = scratch("plannotator-no-bunfig-");
    const env = { ...baseEnv(), HOME: cwd };
    const theDefault = join(cwd, ".plannotator");
    const sim = await bun([join(repoRoot, "scripts", "inbox-sim.ts"), "--binary", "/nonexistent", "--data-dir", "~/.plannotator"], cwd, env);
    expect(sim.code).toBe(2);
    expect(sim.stderr).toContain("real Plannotator data directory");
    const dom = await bun([join(repoRoot, "tests", "helpers", "inbox-dom-server.ts"), theDefault, cwd, "1"], cwd, env);
    expect(dom.code).not.toBe(0);
    expect(dom.stderr).toContain("real Plannotator data directory");
    const dast = await bun([join(repoRoot, "scripts", "dast", "target.ts")], cwd, { ...env, PLANNOTATOR_DAST_ISOLATED: "1", PLANNOTATOR_DATA_DIR: theDefault });
    expect(dast.code).not.toBe(0);
    expect(dast.stderr).toContain("real Plannotator data directory");
    const dastUnset = await bun([join(repoRoot, "scripts", "dast", "target.ts")], cwd, { ...env, PLANNOTATOR_DAST_ISOLATED: "1" });
    expect(dastUnset.code).not.toBe(0);
    expect(dastUnset.stderr).toContain("no data directory");
  }, 60_000);
});

describe("a pid is signalled only once it is proven to be the test's own Inbox", () => {
  /** A process whose command line reads `plannotator inbox`, started in `cwd`. */
  function fakeInbox(cwd: string, bin: string): { pid: number; kill: (signal?: NodeJS.Signals) => boolean; exited: Promise<void> } {
    mkdirSync(bin, { recursive: true });
    const script = join(bin, "plannotator");
    writeFileSync(script, "#!/bin/sh\nwhile :; do sleep 1; done\n");
    chmodSync(script, 0o755);
    const child = spawn(script, ["inbox"], { cwd, stdio: "ignore" });
    const exited = new Promise<void>((done) => child.on("exit", () => done()));
    const handle = { pid: child.pid!, kill: (signal?: NodeJS.Signals) => child.kill(signal ?? "SIGKILL"), exited };
    children.push(handle);
    return handle;
  }

  /** A loopback port nothing listens on. */
  async function closedPort(): Promise<number> {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = server.port as number;
    server.stop(true);
    return port;
  }

  test("not an Inbox command line (this test runner itself): never", async () => {
    const root = scratch("plannotator-proof-");
    const entry = { pid: process.pid, port: await closedPort(), serverSession: "s" };
    expect(await provenInbox(entry, root)).toBe(false);
    expect(await signalProvenInbox(entry, root, "SIGTERM")).toBe(false);
  });

  test("an Inbox command line whose folder is elsewhere: never; inside the test's folder: yes", async () => {
    const root = scratch("plannotator-proof-");
    const elsewhere = scratch("plannotator-proof-elsewhere-");
    const port = await closedPort();

    const outside = fakeInbox(elsewhere, join(root, "bin"));
    await Bun.sleep(200);
    expect(await provenInbox({ pid: outside.pid, port, serverSession: "s" }, root)).toBe(false);
    expect(await signalProvenInbox({ pid: outside.pid, port, serverSession: "s" }, root, "SIGKILL")).toBe(false);
    expect(isRunning(outside.pid)).toBe(true);

    const inside = fakeInbox(join(root, "bin"), join(root, "bin2"));
    await Bun.sleep(200);
    expect(await provenInbox({ pid: inside.pid, port, serverSession: "s" }, root)).toBe(true);
    expect(await signalProvenInbox({ pid: inside.pid, port, serverSession: "s" }, root, "SIGKILL")).toBe(true);
    await inside.exited;
  }, 20_000);

  test("a port answering for another Inbox (another serverSession): never", async () => {
    const root = scratch("plannotator-proof-");
    const fake = fakeInbox(root, join(root, "bin"));
    const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ pid: fake.pid, serverSession: "the-other-one" }) });
    try {
      await Bun.sleep(200);
      expect(await provenInbox({ pid: fake.pid, port: other.port as number, serverSession: "ours" }, root)).toBe(false);
      expect(await provenInbox({ pid: fake.pid, port: other.port as number, serverSession: "the-other-one" }, root)).toBe(true);
      // The same answering process is never the test's when `root` is not a scratch folder.
      expect(await provenInbox({ pid: fake.pid, port: other.port as number, serverSession: "the-other-one" }, join(accountHome, ".plannotator"))).toBe(false);
      expect(await provenInbox({ pid: fake.pid, port: other.port as number, serverSession: "the-other-one" }, "/opt/plannotator-relocated-data-probe")).toBe(false);
    } finally {
      other.stop(true);
    }
  }, 20_000);

  test("health answering for the entry is not enough: the process's folder must be the test's", async () => {
    const root = scratch("plannotator-proof-");
    const elsewhere = scratch("plannotator-proof-elsewhere-");
    const fake = fakeInbox(elsewhere, join(root, "bin"));
    const answering = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ pid: fake.pid, serverSession: "s" }) });
    try {
      await Bun.sleep(200);
      expect(await provenInbox({ pid: fake.pid, port: answering.port as number, serverSession: "s" }, root)).toBe(false);
      expect(await provenInbox({ pid: fake.pid, port: answering.port as number, serverSession: "s" }, elsewhere)).toBe(true);
    } finally {
      answering.stop(true);
    }
  }, 20_000);
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
