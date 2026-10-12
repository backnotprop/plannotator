/**
 * Tests and dev scripts can never reach the person's real Inbox or data dir.
 *
 * Two halves:
 *
 *  1. A source scan of every test and dev script. It fails on
 *     - a raw `process.kill(<pid>, <signal>)` in a file that handles Inbox
 *       processes or registries, outside tests/helpers/inbox-process.ts (the
 *       one place that signals, and only once the pid is proven to be the
 *       Inbox that test started);
 *     - a path built from the home directory to `.plannotator`, outside
 *       tests/helpers/real-data-dir.ts (the one place that names it, to refuse it);
 *     - a `startInboxServer(...)` call that does not name its `dataDir` (it
 *       would fall back to the default data dir).
 *  2. The guards themselves: the real data dir (and anything inside it) is
 *     refused however it is spelled, the import-time sandbox works with no
 *     bunfig at all, and a pid that is not provably the test's Inbox is never
 *     signalled.
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
import { accountHome as accountHomeOf, isRealDataDir, realDataDirs, refuseRealDataDir } from "./helpers/real-data-dir";

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

/** The argument list of the call whose `(` is at `open`, split at top-level commas. */
function callArgs(text: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    // Comments are skipped (an apostrophe in one is not a quote); they still count as argument text.
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        args.push(text.slice(start, i).trim());
        return args.filter((a) => a.length > 0);
      }
    } else if (c === "," && depth === 1) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return args;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

/** A file that handles Inbox processes or their registries. */
const HANDLES_INBOX = /inbox\.json|readInboxRegistry|inboxEntryOf|InboxRegistry|startInbox|inbox-world|inbox-scratch|["']inbox["'],\s*["']--background["']|\/api\/inbox\//;

// This file holds the scan's own fixtures (in strings) and signals only children it spawned.
const SIGNAL_ALLOWED = new Set(["tests/helpers/inbox-process.ts", "tests/never-touch-the-real-inbox.test.ts"]);
const HOME_PATH_ALLOWED = new Set(["tests/helpers/real-data-dir.ts", "tests/never-touch-the-real-inbox.test.ts"]);

/** `homedir()` (or $HOME) and `.plannotator` (as a whole path segment) on one line. */
const HOME_DATA_DIR = /(?:\bhomedir\(\)|userInfo\(\)\.homedir|process\.env\.HOME\b|Bun\.env\.HOME\b)[^\n]*?["'`/\\]\.plannotator(?![\w.-])/;

describe("the source scan", () => {
  const files = sources();

  test("finds the test and script sources it guards", () => {
    // Sentinels: if the walk stops reaching these, the scan proves nothing.
    for (const known of ["tests/helpers/inbox-world.ts", "tests/e2e/inbox-scratch.ts", "apps/hook/server/inbox-cli.test.ts", "scripts/dast/target.ts", "scripts/inbox-sim.ts"]) {
      expect(files).toContain(known);
    }
  });

  test("no raw signal to an Inbox pid outside tests/helpers/inbox-process.ts", () => {
    const found: string[] = [];
    for (const file of files) {
      if (SIGNAL_ALLOWED.has(file)) continue;
      const text = readFileSync(join(repoRoot, file), "utf8");
      if (!HANDLES_INBOX.test(text)) continue;
      for (const match of text.matchAll(/\bprocess\.kill\s*\(/g)) {
        const args = callArgs(text, match.index! + match[0].length - 1);
        if (args[1] === "0") continue; // An existence probe sends nothing.
        found.push(`${file}:${lineOf(text, match.index!)}: process.kill(${args.join(", ")})`);
      }
      for (const match of text.matchAll(/\[\s*["'](?:kill|pkill|killall)["']|\b(?:pkill|killall)\s/g)) {
        found.push(`${file}:${lineOf(text, match.index!)}: ${match[0].trim()}`);
      }
    }
    // Use signalInbox / stopInbox (tests/helpers/inbox-world.ts), stopScratchInbox
    // (tests/e2e/inbox-scratch.ts) or the inbox-process helpers instead.
    expect(found).toEqual([]);
  });

  test("no path from the home directory to .plannotator outside tests/helpers/real-data-dir.ts", () => {
    const found: string[] = [];
    for (const file of files) {
      if (HOME_PATH_ALLOWED.has(file)) continue;
      const lines = readFileSync(join(repoRoot, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (HOME_DATA_DIR.test(line)) found.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });

  test("every startInboxServer call names its dataDir", () => {
    const found: string[] = [];
    for (const file of files) {
      if (file === "tests/never-touch-the-real-inbox.test.ts") continue; // Its fixtures name the call in strings.
      const text = readFileSync(join(repoRoot, file), "utf8");
      for (const match of text.matchAll(/\bstartInboxServer\s*\(/g)) {
        const args = callArgs(text, match.index! + match[0].length - 1);
        // `start(overrides)` wrappers spread an options object that names it; the call itself must.
        if (!/\bdataDir\b/.test(args[0] ?? "")) found.push(`${file}:${lineOf(text, match.index!)}`);
      }
    }
    expect(found).toEqual([]);
  });

  test("the scan catches what it is for (a fixture in memory, not on disk)", () => {
    const text = `const { pid } = JSON.parse(readFileSync(join(dataDir, "inbox", "inbox.json"), "utf8"));\nprocess.kill(pid, "SIGKILL");\nprocess.kill(pid, 0);\n`;
    const calls = [...text.matchAll(/\bprocess\.kill\s*\(/g)].map((m) => callArgs(text, m.index! + m[0].length - 1));
    expect(HANDLES_INBOX.test(text)).toBe(true);
    expect(calls.filter((args) => args[1] !== "0")).toEqual([["pid", '"SIGKILL"']]);
    expect(HOME_DATA_DIR.test(`const dir = join(homedir(), ".plannotator", "inbox");`)).toBe(true);
    expect(HOME_DATA_DIR.test(`const dir = join(homedir(), ".plannotator-resolve-file-");`)).toBe(false);
    expect(callArgs(`startInboxServer({ version: "x", phones: true })`, 16)[0]).not.toMatch(/\bdataDir\b/);
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
    expect(dir.length).toBeGreaterThan(0);
    expect(isRealDataDir(dir)).toBe(false);
    expect(realpathSync(tmpdir()) === dir || dir.startsWith(tmpdir()) || dir.startsWith(realpathSync(tmpdir()))).toBe(true);
  });

  test("PLANNOTATOR_DATA_DIR naming the real data dir: the import refuses before anything runs", async () => {
    const cwd = scratch("plannotator-no-bunfig-");
    for (const value of ["~/.plannotator", join(accountHome, ".plannotator")]) {
      const result = await bun([probe], cwd, { ...baseEnv(), PLANNOTATOR_DATA_DIR: value });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("real Plannotator data directory");
      expect(result.stdout).toBe("");
    }
  });

  test("HOME pointed elsewhere does not hide the account's own ~/.plannotator", async () => {
    const cwd = scratch("plannotator-no-bunfig-");
    const result = await bun([probe], cwd, { ...baseEnv(), HOME: cwd, PLANNOTATOR_DATA_DIR: join(accountHome, ".plannotator") });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("real Plannotator data directory");
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
    } finally {
      other.stop(true);
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
