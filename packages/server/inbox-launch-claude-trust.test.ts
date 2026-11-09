/**
 * Trust folder's Claude side (docs/agent-guides/inbox-launch.md, "Trusting a folder"). What each test guards: the
 * write changes one value and no other byte, keeps the mode and any link, and never replaces a file it can't read
 * or an empty one; Claude's lock is taken, waited for, and survives two writers at once in separate processes; the
 * file is the one Claude picks and the key the one it uses (physical, NFC, a worktree's main checkout), and
 * `claudeTrustsFolder` reads them; the warning counts what Claude's own prompt warns on and says what it could not
 * read; the owner's click goes through the real server, into a sandboxed config, and a guest gets neither the button
 * nor the route.
 *
 * Every config here is under a temp folder through `refuseRealClaudeConfig`; a real `~/.claude.json` is never read.
 * The sandbox import comes first so a run with no bunfig preload (any folder but the repository's root) is sandboxed
 * too, and the real-server test sets its own marker and HOME for a shell that already names a scratch data dir.
 */
import "../../tests/setup/sandbox-data-dir";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { accountHome, refuseRealClaudeConfig } from "../../tests/helpers/real-data-dir";
import { scriptedTailscale, TAILNET_MAGIC as MAGIC, TAILNET_OWNER as OWNER } from "../../tests/helpers/scripted-tailscale";
import { startInboxServer, type InboxServer } from "./inbox";
import { claudeGlobalConfigPath, createAgentEnvironmentFor } from "./inbox-agents";
import { claudeTrustsFolder, createClaudeLaunchHost } from "./inbox-launch-claude";
import { acceptClaudeTrust, claudeTrustKey, claudeTrustReading } from "./inbox-launch-claude-trust";
import type { LaunchHostContext } from "./inbox-launch-host";

const claudeTrustWarning = (folders: readonly string[]) => claudeTrustReading(folders).warning;

/** Only ever handed to the guard below, never opened. */
const CLAUDE_DIR = ".claude";

const restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
});

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-claude-trust-")));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const configDir = refuseRealClaudeConfig(join(root, "claude-config"), "inbox-launch-claude-trust.test");
  mkdirSync(home);
  mkdirSync(configDir);
  const config = join(configDir, ".claude.json");
  const files = createAgentEnvironmentFor({ platform: "darwin", homeDir: home, env: { CLAUDE_CONFIG_DIR: configDir } });
  return { root, home, configDir, config, files };
}

const GIT_ENV = { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };
function git(cwd: string, ...args: string[]) {
  const result = spawnSync("/usr/bin/git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}
/** A repository with one commit, and a linked worktree of it. */
function repoWithWorktree(root: string) {
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "commit", "-q", "--allow-empty", "-m", "first");
  const worktree = join(root, "linked");
  git(repo, "worktree", "add", "-q", worktree, "-b", "linked");
  return { repo, worktree };
}

describe("the write", () => {
  test("adds one value: every other byte stays, the mode too", async () => {
    const { config } = sandbox();
    const before = '{\n    "numStartups": 12,\n    "oauthAccount": {"email": "a@b.c"},\n    "projects": {\n        "/other": {"allowedTools": ["Bash"], "hasTrustDialogAccepted": false}\n    },\n    "tail": 1.50\n}\n';
    writeFileSync(config, before);
    chmodSync(config, 0o640);
    await acceptClaudeTrust(config, "/new");
    const after = readFileSync(config, "utf8");
    expect(JSON.parse(after).projects["/new"]).toEqual({ hasTrustDialogAccepted: true });
    expect(JSON.parse(after).oauthAccount).toEqual({ email: "a@b.c" });
    // What a re-serialize would change is still as it was: 1.50, the compact objects, the four-space indent.
    expect(after).toContain('"tail": 1.50\n}\n');
    expect(after).toContain('"/other": {"allowedTools": ["Bash"], "hasTrustDialogAccepted": false}');
    expect(after.startsWith('{\n    "numStartups": 12,\n    "oauthAccount": {"email": "a@b.c"},\n    "projects": {\n')).toBe(true);
    expect(statSync(config).mode & 0o777).toBe(0o640);
    expect(existsSync(`${config}.lock`)).toBe(false);
  });

  test("an entry Claude left false turns true, its other fields kept; already true writes nothing", async () => {
    const { config } = sandbox();
    writeFileSync(config, '{"projects":{"/a":{"allowedTools":["Read"],"hasTrustDialogAccepted":false}}}');
    await acceptClaudeTrust(config, "/a");
    expect(readFileSync(config, "utf8")).toBe('{"projects":{"/a":{"allowedTools":["Read"],"hasTrustDialogAccepted":true}}}');
    const inode = statSync(config).ino;
    await acceptClaudeTrust(config, "/a");
    expect(statSync(config).ino).toBe(inode);
  });

  test("no file yet: made, private; a symbolic link (dotfiles) is written at its target and stays a link", async () => {
    const { root, config } = sandbox();
    await acceptClaudeTrust(config, "/a");
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ projects: { "/a": { hasTrustDialogAccepted: true } } });
    expect(statSync(config).mode & 0o777).toBe(0o600);

    const dotfiles = join(root, "dotfiles.json");
    renameSync(config, dotfiles);
    symlinkSync(dotfiles, config);
    await acceptClaudeTrust(config, "/b");
    expect(lstatSync(config).isSymbolicLink()).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(dotfiles, "utf8")).projects)).toEqual(["/a", "/b"]);
  });

  test("a file it can't read as JSON is never replaced, and the lock is let go", async () => {
    const { config } = sandbox();
    for (const text of ['{"projects": {', '{"projects": []}', '{"projects": {"/a": 7}}']) {
      writeFileSync(config, text);
      await expect(acceptClaudeTrust(config, "/a")).rejects.toThrow(/plain JSON|not an object/);
      expect(readFileSync(config, "utf8")).toBe(text);
      expect(existsSync(`${config}.lock`)).toBe(false);
    }
  });

  test("an empty config is refused and left: Claude repairs that file itself, and only while it stays empty", async () => {
    const { config } = sandbox();
    for (const text of ["", " \n\t\n"]) {
      writeFileSync(config, text);
      await expect(acceptClaudeTrust(config, "/a")).rejects.toThrow("it is empty");
      expect(readFileSync(config, "utf8")).toBe(text);
      expect(existsSync(`${config}.lock`)).toBe(false);
    }
  });

  test("a config past the 1 MiB other agent files stop at is written; past 32 MiB it is refused and left", async () => {
    const { config } = sandbox();
    const big = `{"history":"${"x".repeat(2 * 1024 * 1024)}"}`;
    writeFileSync(config, big);
    await acceptClaudeTrust(config, "/a");
    expect(JSON.parse(readFileSync(config, "utf8")).projects["/a"]).toEqual({ hasTrustDialogAccepted: true });
    const huge = `{"history":"${"x".repeat(33 * 1024 * 1024)}"}`;
    writeFileSync(config, huge);
    await expect(acceptClaudeTrust(config, "/a")).rejects.toThrow("larger than 32 MiB");
    expect(statSync(config).size).toBe(huge.length);
  });

  test("a BOM stays: every other byte means that one too", async () => {
    const { config } = sandbox();
    writeFileSync(config, '\uFEFF{"numStartups":1}');
    await acceptClaudeTrust(config, "/a");
    expect([...readFileSync(config).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(JSON.parse(readFileSync(config, "utf8").slice(1)).numStartups).toBe(1);
  });

  test("the new file is flushed to disk before it replaces the config, as Claude's save is", async () => {
    const { config } = sandbox();
    writeFileSync(config, "{}");
    const fsync = spyOn(fs, "fsyncSync");
    restore.push(() => fsync.mockRestore());
    await acceptClaudeTrust(config, "/a");
    expect(fsync).toHaveBeenCalledTimes(1);
  });

  test("a link that loops and a file nested past the parser say so in plain words", async () => {
    const { config } = sandbox();
    symlinkSync(config, `${config}.other`);
    symlinkSync(`${config}.other`, config);
    await expect(acceptClaudeTrust(config, "/a")).rejects.toThrow("it is a link that leads back to itself");
    rmSync(config);
    const deep = `${'{"a":'.repeat(200_000)}1${"}".repeat(200_000)}`;
    writeFileSync(config, deep);
    await expect(acceptClaudeTrust(config, "/a")).rejects.toThrow("it is nested too deeply");
    expect(statSync(config).size).toBe(deep.length);
  });
});

describe("the file, as Claude Code picks it", () => {
  const LEGACY = ".config.json";

  test("a legacy .config.json with anything in it: the click writes there, the reader reads there, and no .claude.json appears", async () => {
    const { root, home, configDir, config, files } = sandbox();
    const legacy = join(configDir, LEGACY);
    const folder = join(root, "project");
    mkdirSync(folder);
    writeFileSync(legacy, '{"numStartups":3}');
    const context = { homeDir: home, platform: "darwin", dataDir: join(home, "data"), shell: () => null, ownEnv: () => ({ CLAUDE_CONFIG_DIR: configDir }), displayFolder: (path: string) => path } as unknown as LaunchHostContext;
    await createClaudeLaunchHost(context).trustOffer({ folder, scratch: false } as never)!.accept();
    expect(JSON.parse(readFileSync(legacy, "utf8"))).toEqual({ numStartups: 3, projects: { [folder]: { hasTrustDialogAccepted: true } } });
    expect(existsSync(config)).toBe(false);
    expect(claudeTrustsFolder(files, folder)).toBe(true);
  });

  test("an empty one counts only while writable and with no usual file; a folder of that name never", () => {
    const { configDir, config, files } = sandbox();
    const legacy = join(configDir, LEGACY);
    expect(claudeGlobalConfigPath(files)).toBe(config);
    writeFileSync(legacy, "");
    expect(claudeGlobalConfigPath(files)).toBe(legacy);
    writeFileSync(config, "{}");
    expect(claudeGlobalConfigPath(files)).toBe(config);
    rmSync(config);
    chmodSync(legacy, 0o444);
    expect(claudeGlobalConfigPath(files)).toBe(config);
    rmSync(legacy, { force: true });
    mkdirSync(legacy);
    expect(claudeGlobalConfigPath(files)).toBe(config);
  });

  test("with no CLAUDE_CONFIG_DIR the legacy file is in ~/.claude and the usual one in the home folder; a custom OAuth URL has its own name, from the login shell too", () => {
    const { home, configDir } = sandbox();
    const plain = createAgentEnvironmentFor({ platform: "darwin", homeDir: home, env: {} });
    expect(claudeGlobalConfigPath(plain)).toBe(join(home, ".claude.json"));
    mkdirSync(join(home, CLAUDE_DIR));
    writeFileSync(join(home, CLAUDE_DIR, LEGACY), "{}");
    expect(claudeGlobalConfigPath(plain)).toBe(join(home, CLAUDE_DIR, LEGACY));

    const custom = createAgentEnvironmentFor({ platform: "darwin", homeDir: home, env: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_CUSTOM_OAUTH_URL: "https://sso.example" } });
    expect(claudeGlobalConfigPath(custom)).toBe(join(configDir, ".claude-custom-oauth.json"));
  });
});

describe("Claude's lock", () => {
  test("a holder is waited for, and what it saved under the lock stays", async () => {
    const { config } = sandbox();
    writeFileSync(config, '{"numStartups":1}');
    mkdirSync(`${config}.lock`);
    const writing = acceptClaudeTrust(config, "/a");
    await Bun.sleep(150);
    expect(readFileSync(config, "utf8")).toBe('{"numStartups":1}');
    // Claude saves, then lets go.
    writeFileSync(config, '{"numStartups":2}');
    rmdirSync(`${config}.lock`);
    await writing;
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ numStartups: 2, projects: { "/a": { hasTrustDialogAccepted: true } } });
  });

  test("a lock nobody refreshes for 10 s is dead and is cleared; a live one past the wait is left alone and nothing is written", async () => {
    const { config } = sandbox();
    writeFileSync(config, "{}");
    mkdirSync(`${config}.lock`);
    await expect(acceptClaudeTrust(config, "/a", 120)).rejects.toThrow("Claude Code is holding it");
    expect(existsSync(`${config}.lock`)).toBe(true);
    expect(readFileSync(config, "utf8")).toBe("{}");
    const old = new Date(Date.now() - 30_000);
    utimesSync(`${config}.lock`, old, old);
    await acceptClaudeTrust(config, "/a", 120);
    expect(JSON.parse(readFileSync(config, "utf8")).projects["/a"]).toEqual({ hasTrustDialogAccepted: true });
    expect(existsSync(`${config}.lock`)).toBe(false);
  });

  test("a dead lock that can't be cleared says so, not that Claude holds it, and nothing is written", async () => {
    const { config } = sandbox();
    writeFileSync(config, "{}");
    writeFileSync(`${config}.lock`, "not a lock");
    const old = new Date(Date.now() - 30_000);
    utimesSync(`${config}.lock`, old, old);
    await expect(acceptClaudeTrust(config, "/a", 120)).rejects.toThrow(".claude.json.lock is in the way and can't be removed");
    expect(readFileSync(config, "utf8")).toBe("{}");
  });

  test("`allowed` is asked with the lock held: no saves nothing, and the lock is let go", async () => {
    const { config } = sandbox();
    writeFileSync(config, '{"numStartups":1}');
    let held = false;
    await acceptClaudeTrust(config, "/a", undefined, () => {
      held = existsSync(`${config}.lock`);
      return false;
    });
    expect(held).toBe(true);
    expect(readFileSync(config, "utf8")).toBe('{"numStartups":1}');
    expect(existsSync(`${config}.lock`)).toBe(false);
  });

  test("writers in separate processes at once lose no entry", async () => {
    const { root, config } = sandbox();
    writeFileSync(config, '{"numStartups":1}');
    const writer = join(root, "writer.ts");
    writeFileSync(writer, `import { acceptClaudeTrust } from ${JSON.stringify(join(import.meta.dir, "inbox-launch-claude-trust.ts"))};\nconst [config, ...keys] = process.argv.slice(2);\nfor (const key of keys) await acceptClaudeTrust(config!, key, 30_000);\n`);
    const keys = (writerId: number) => Array.from({ length: 12 }, (_, i) => `/w${writerId}/k${i}`);
    const writers = [0, 1, 2, 3, 4, 5].map((id) => Bun.spawn([process.execPath, writer, config, ...keys(id)], { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", HOME: root, PLANNOTATOR_DATA_DIR: join(root, "data") } }));
    const exits = await Promise.all(writers.map(async (w) => [await w.exited, await new Response(w.stderr).text()] as const));
    expect(exits).toEqual(writers.map(() => [0, ""] as const));
    const saved = JSON.parse(readFileSync(config, "utf8"));
    expect(Object.keys(saved.projects).sort()).toEqual([0, 1, 2, 3, 4, 5].flatMap(keys).sort());
    expect(saved.numStartups).toBe(1);
    expect(existsSync(`${config}.lock`)).toBe(false);
  }, 30_000);
});

describe("the key, as Claude Code uses it", () => {
  // In a process of its own: a read that blocks on a FIFO can't be timed out from inside this one.
  test.skipIf(process.platform === "win32")("a FIFO named .git, or one a .git file points at, never blocks the Inbox: it counts for nothing", () => {
    const { root } = sandbox();
    const repo = join(root, "repo");
    const named = join(repo, "named");
    const pointed = join(root, "pointed");
    const gitDir = join(root, "gitdir");
    for (const dir of [join(repo, ".git"), named, pointed, gitDir]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(pointed, ".git"), `gitdir: ${gitDir}\n`);
    for (const fifo of [join(named, ".git"), join(gitDir, "commondir")]) expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const probe = join(root, "probe.ts");
    writeFileSync(probe, `import { claudeTrustKey } from ${JSON.stringify(join(import.meta.dir, "inbox-launch-claude-trust.ts"))};\nconsole.log(JSON.stringify(process.argv.slice(2).map((f) => claudeTrustKey(f))));\n`);
    const run = Bun.spawnSync([process.execPath, probe, named, pointed], { timeout: 15_000, env: { PATH: "/usr/bin:/bin", HOME: root, PLANNOTATOR_DATA_DIR: join(root, "data") } });
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout.toString())).toEqual([repo, pointed]);
  }, 20_000);

  test("a folder outside a repository is its own key, physical; a repository's subfolder is its root; a link leads to the real path", () => {
    const { root } = sandbox();
    const plain = join(root, "plain", "deep");
    mkdirSync(plain, { recursive: true });
    expect(claudeTrustKey(plain)).toBe(plain);
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "packages", "x"), { recursive: true });
    expect(claudeTrustKey(join(repo, "packages", "x"))).toBe(repo);
    symlinkSync(repo, join(root, "link"));
    expect(claudeTrustKey(join(root, "link", "packages"))).toBe(repo);
  });

  test("a linked worktree is its main checkout's; a copied .git file that does not point back stays its own", () => {
    const { root } = sandbox();
    const { repo, worktree } = repoWithWorktree(root);
    mkdirSync(join(worktree, "sub"));
    expect(claudeTrustKey(worktree)).toBe(repo);
    expect(claudeTrustKey(join(worktree, "sub"))).toBe(repo);
    const copy = join(root, "copy");
    mkdirSync(copy);
    writeFileSync(join(copy, ".git"), readFileSync(join(worktree, ".git")));
    expect(claudeTrustKey(copy)).toBe(copy);
  });

  test("a name in decomposed form is keyed in NFC, as Claude normalizes it", () => {
    const { root } = sandbox();
    const decomposed = join(root, "café");
    mkdirSync(decomposed);
    expect(claudeTrustKey(decomposed)).toBe(join(root, "café"));
    // A repository's root goes the same way.
    mkdirSync(join(root, "cafe\u0301-repo", ".git"), { recursive: true });
    mkdirSync(join(root, "cafe\u0301-repo", "sub"));
    expect(claudeTrustKey(join(root, "cafe\u0301-repo", "sub"))).toBe(join(root, "caf\u00E9-repo"));
  });

  test("a linked worktree of a bare repository is that bare repository's", () => {
    const { root } = sandbox();
    const { repo } = repoWithWorktree(root);
    const bare = join(root, "bare.git");
    git(root, "clone", "-q", "--bare", repo, bare);
    const worktree = join(root, "from-bare");
    git(bare, "worktree", "add", "-q", worktree, "-b", "from-bare");
    expect(claudeTrustKey(worktree)).toBe(bare);
  });

  test("claudeTrustsFolder reads that key: a worktree of a trusted repository, a link, and a nested repository still refused", async () => {
    const { root, config, files } = sandbox();
    const { repo, worktree } = repoWithWorktree(root);
    expect(claudeTrustsFolder(files, worktree)).toBe(false);
    await acceptClaudeTrust(config, claudeTrustKey(worktree));
    expect(Object.keys(JSON.parse(readFileSync(config, "utf8")).projects)).toEqual([repo]);
    expect(claudeTrustsFolder(files, worktree)).toBe(true);
    expect(claudeTrustsFolder(files, repo)).toBe(true);

    const plain = join(root, "plain");
    mkdirSync(join(plain, "child"), { recursive: true });
    symlinkSync(plain, join(root, "plain-link"));
    await acceptClaudeTrust(config, claudeTrustKey(join(root, "plain-link")));
    expect(claudeTrustsFolder(files, join(root, "plain-link", "child"))).toBe(true);
    // A key as written through the link is not one Claude would ever match.
    const unphysical = join(root, "other-link");
    const other = join(root, "other");
    mkdirSync(other);
    symlinkSync(other, unphysical);
    await acceptClaudeTrust(config, unphysical);
    expect(claudeTrustsFolder(files, other)).toBe(false);

    mkdirSync(join(plain, "nested", ".git"), { recursive: true });
    expect(claudeTrustsFolder(files, join(plain, "nested"))).toBe(false);
  });
});

describe("the warning", () => {
  function folder(root: string, files: Record<string, unknown>) {
    const dir = join(root, "folder");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
    return dir;
  }
  const hook = { hooks: [{ type: "command", command: "x" }] };

  test("counts each hook across both settings files, each MCP server, and helper commands; nothing there, no line", () => {
    const { root } = sandbox();
    expect(claudeTrustWarning([folder(root, {})])).toBeNull();
    const dir = folder(root, {
      ".claude/settings.json": { hooks: { PreToolUse: [hook, hook], Stop: [{ hooks: [{ type: "command", command: "a" }, { type: "command", command: "b" }] }] }, apiKeyHelper: "./key.sh" },
      ".claude/settings.local.json": { hooks: { SessionStart: [hook] } },
      ".mcp.json": { mcpServers: { one: { command: "x" }, two: { url: "https://x", headersHelper: "./h.sh" } } },
    });
    expect(claudeTrustWarning([dir])).toBe("This folder has 5 hooks, 2 MCP servers and 2 helper commands that will run once you trust it.");
  });

  test("one of a kind reads singular; settings with none of these are no line; a folder named twice counts once", () => {
    const { root } = sandbox();
    const dir = folder(root, { ".claude/settings.json": { hooks: { Stop: [hook] }, model: "x" }, ".mcp.json": { mcpServers: { only: {} } } });
    expect(claudeTrustWarning([dir, dir])).toBe("This folder has 1 hook and 1 MCP server that will run once you trust it.");
    writeFileSync(join(dir, ".claude/settings.json"), '{"model":"x","permissions":{"allow":[],"additionalDirectories":[]},"env":{}}');
    rmSync(join(dir, ".mcp.json"));
    expect(claudeTrustWarning([dir])).toBeNull();
  });

  test("every command Claude's own trust prompt warns on counts: status line, file suggestion, proxy and marketplace helpers", () => {
    const { root } = sandbox();
    const command = { type: "command", command: "./x.sh" };
    const dir = folder(root, {
      ".claude/settings.json": { statusLine: command, subagentStatusLine: command, fileSuggestion: command, proxyAuthHelper: "./p.sh", extraKnownMarketplaces: { m: { source: { source: "url", url: "https://x", headersHelper: "./h.sh" } } } },
    });
    expect(claudeTrustWarning([dir])).toBe("This folder has 3 hooks and 2 helper commands that will run once you trust it.");
  });

  test("env settings count with what runs; allow rules and outside folders are said as what they let Claude Code do", () => {
    const { root } = sandbox();
    const dir = folder(root, { ".claude/settings.json": { env: { NODE_OPTIONS: "--require ./x.js" } } });
    const settings = (value: unknown) => writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify(value));
    expect(claudeTrustWarning([dir])).toBe("This folder has env settings that will run once you trust it.");
    settings({ permissions: { allow: ["Bash"] } });
    expect(claudeTrustWarning([dir])).toBe("Once you trust it, this folder's settings let Claude Code use some tools without asking.");
    settings({ permissions: { additionalDirectories: ["../other"] } });
    expect(claudeTrustWarning([dir])).toBe("Once you trust it, this folder's settings let Claude Code reach folders outside it.");
    settings({ autoMemoryDirectory: "/elsewhere" });
    expect(claudeTrustWarning([dir])).toBe("Once you trust it, this folder's settings let Claude Code reach folders outside it.");
    settings({ hooks: { Stop: [hook] }, env: { A: "1" }, permissions: { allow: ["Bash"], additionalDirectories: ["../other"] } });
    expect(claudeTrustWarning([dir])).toBe("This folder has 1 hook and env settings that will run once you trust it. Its settings also let Claude Code use some tools without asking and reach folders outside it.");
  });

  test("a .mcp.json in any folder above counts, each server name once; a server turned off in the settings does not", () => {
    const { root } = sandbox();
    const dir = folder(root, { ".mcp.json": { mcpServers: { near: {}, same: {} } } });
    const parent = join(root, ".mcp.json");
    writeFileSync(parent, JSON.stringify({ mcpServers: { above: { headersHelper: "./h.sh" }, same: {} } }));
    expect(claudeTrustWarning([dir])).toBe("This folder has 3 MCP servers and 1 helper command that will run once you trust it.");
    writeFileSync(join(dir, ".claude/settings.local.json"), JSON.stringify({ disabledMcpjsonServers: ["above", "same"] }));
    expect(claudeTrustWarning([dir])).toBe("This folder has 1 MCP server that will run once you trust it.");
  });

  test("a file that can't be read is said in the same line, with or without counts, and never shown", () => {
    const { root } = sandbox();
    const dir = folder(root, { ".mcp.json": "{ secret-looking text" });
    expect(claudeTrustWarning([dir])).toBe("This folder's .mcp.json couldn't be read, so it may run something once you trust it.");
    writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify({ hooks: { Stop: [hook] } }));
    expect(claudeTrustWarning([dir])).toBe("This folder has 1 hook that will run once you trust it. Its .mcp.json couldn't be read, so there may be more.");
    mkdirSync(join(dir, ".claude/settings.local.json"));
    expect(claudeTrustWarning([dir])).toBe("This folder has 1 hook that will run once you trust it. Its .claude/settings.local.json and .mcp.json couldn't be read, so there may be more.");
  });
});

describe("the Claude host's offer", () => {
  function host(home: string, configDir: string, shell: Record<string, string> | null = null) {
    const context = { homeDir: home, platform: "darwin", dataDir: join(home, "data"), shell: () => shell, ownEnv: () => ({ CLAUDE_CONFIG_DIR: configDir }), displayFolder: (path: string) => path } as unknown as LaunchHostContext;
    return createClaudeLaunchHost(context);
  }
  const launch = (folder: string, scratch = false) => ({ folder, scratch }) as never;

  test("a scratch launch trusts the scratch root; the warning covers the launch's folder and the folder trusted", async () => {
    const { root, home, configDir, config } = sandbox();
    const scratchRoot = join(root, "scratch");
    const folder = join(scratchRoot, "one");
    mkdirSync(join(scratchRoot, ".claude"), { recursive: true });
    mkdirSync(folder);
    writeFileSync(join(scratchRoot, ".claude/settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{}] }] } }));
    writeFileSync(join(folder, ".mcp.json"), JSON.stringify({ mcpServers: { one: {} } }));
    const offer = host(home, configDir).trustOffer(launch(folder, true))!;
    expect(offer.read().warning).toBe("This folder has 1 hook and 1 MCP server that will run once you trust it.");
    expect(offer.folder).toBe(scratchRoot);
    await offer.accept();
    expect(Object.keys(JSON.parse(readFileSync(config, "utf8")).projects)).toEqual([scratchRoot]);
  });

  test("compose's pick, before any launch: a folder's facts are the warning's, short; a clean folder has none and nothing warns", () => {
    const { root, home, configDir } = sandbox();
    const dir = join(root, "billing");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const offerFor = () => host(home, configDir).trustOffer(launch(dir))!;
    expect(offerFor().read()).toEqual({ warning: null, facts: [], warns: false });
    expect(offerFor().folder).toBe(dir);

    const hook = { hooks: [{}] };
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { one: {}, two: {} } }));
    writeFileSync(
      join(dir, ".claude/settings.json"),
      JSON.stringify({ hooks: { Stop: [hook, hook] }, apiKeyHelper: "./key.sh", env: { A: "1" }, permissions: { allow: ["Bash(ls)"], additionalDirectories: ["/elsewhere"] } }),
    );
    writeFileSync(join(dir, ".claude/settings.local.json"), "not json");
    const read = offerFor().read();
    expect(read.facts).toEqual(["Runs 2 hooks, 2 MCP servers, 1 helper command, env settings", "Uses tools without asking, reaches outside folders", "1 file couldn't be read"]);
    expect(read.warns).toBe(true);
    // The warning comes from the same read: the run line and compose can never disagree on what was counted.
    expect(read.warning).toContain("2 hooks, 2 MCP servers, 1 helper command and env settings");
  });

  test("only one of the two reaches, on its own line, with a capital", () => {
    const { root, home, configDir } = sandbox();
    const dir = join(root, "reach");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify({ autoMemoryDirectory: "/elsewhere" }));
    expect(host(home, configDir).trustOffer(launch(dir))!.read().facts).toEqual(["Reaches outside folders"]);
  });

  test("a linked worktree that brings nothing: one fact, the whole repository, which alone is no warning; the folder named is the one trusted", () => {
    const { root, home, configDir } = sandbox();
    const { repo, worktree } = repoWithWorktree(root);
    const offer = host(home, configDir).trustOffer(launch(worktree))!;
    expect(offer.folder).toBe(repo);
    const read = offer.read();
    expect(read.facts).toEqual([`Whole repository, not just ${basename(worktree)}`]);
    expect(read.warns).toBe(false);

    mkdirSync(join(worktree, ".claude"));
    writeFileSync(join(worktree, ".claude/settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{}] }] } }));
    const warned = offer.read();
    expect(warned.facts).toEqual([`Whole repository, not just ${basename(worktree)}`, "Runs 1 hook"]);
    expect(warned.warns).toBe(true);
  });

  test("the home folder gets no offer: Claude never saves trust there; nor does the root, or a folder above home, which would cover it", () => {
    const { root, home, configDir } = sandbox();
    expect(host(home, configDir).trustOffer(launch(home))).toBeNull();
    expect(host(home, configDir).trustOffer(launch("/"))).toBeNull();
    expect(host(home, configDir).trustOffer(launch(root))).toBeNull();
  });

  test("a linked worktree's line names the repository the trust lands on; its settings count from the launch's root and the main checkout", async () => {
    const { root, home, configDir, config } = sandbox();
    const { repo, worktree } = repoWithWorktree(root);
    const stop = (count: number) => ({ hooks: { Stop: Array.from({ length: count }, () => ({ hooks: [{}] })) } });
    mkdirSync(join(worktree, "sub", ".claude"), { recursive: true });
    mkdirSync(join(worktree, ".claude"));
    mkdirSync(join(repo, ".claude"));
    writeFileSync(join(worktree, ".claude/settings.json"), JSON.stringify(stop(1)));
    writeFileSync(join(repo, ".claude/settings.local.json"), JSON.stringify(stop(2)));
    const offer = host(home, configDir).trustOffer(launch(join(worktree, "sub")))!;
    expect(offer.read().warning).toBe(`This folder has 3 hooks that will run once you trust it. This folder is part of the repository at ${repo}; trusting it trusts that whole repository.`);
    await offer.accept();
    expect(Object.keys(JSON.parse(readFileSync(config, "utf8")).projects)).toEqual([repo]);
  });

  test("a crafted .git file that points at another folder: that folder is scanned and named, and nothing is hidden behind a clean-looking one", () => {
    const { root, home, configDir } = sandbox();
    const shown = join(root, "download", "project");
    const other = join(root, "download", "other");
    const gitDir = join(other, ".git", "worktrees", "x");
    mkdirSync(shown, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    mkdirSync(join(other, ".claude"));
    writeFileSync(join(other, ".claude/settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{}] }] } }));
    writeFileSync(join(shown, ".git"), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, "commondir"), "../..\n");
    writeFileSync(join(gitDir, "gitdir"), `${join(shown, ".git")}\n`);
    expect(host(home, configDir).trustOffer(launch(shown))!.read().warning).toBe(`This folder has 1 hook that will run once you trust it. This folder is part of the repository at ${other}; trusting it trusts that whole repository.`);
  });

  test("a custom OAuth URL in the login shell is followed to the file Claude uses", async () => {
    const { root, home, configDir } = sandbox();
    const folder = join(root, "project");
    mkdirSync(folder);
    await host(home, configDir, { CLAUDE_CODE_CUSTOM_OAUTH_URL: "https://sso.example" }).trustOffer(launch(folder))!.accept();
    expect(existsSync(join(configDir, ".claude-custom-oauth.json"))).toBe(true);
    expect(existsSync(join(configDir, ".claude.json"))).toBe(false);
  });

  test("a failed write says which file and why, for the run line", async () => {
    const { root, home, configDir, config } = sandbox();
    const folder = join(root, "project");
    mkdirSync(folder);
    writeFileSync(config, "not json");
    await expect(host(home, configDir).trustOffer(launch(folder))!.accept()).rejects.toThrow(`Could not update ${config}: it is not plain JSON. Nothing was changed.`);
    expect(readFileSync(config, "utf8")).toBe("not json");
  });
});

describe("through a real server", () => {
  const GUEST = "guest@example.com";

  test("a guest on the allow list gets no offer and a refused route; the owner over the tailnet writes, into the sandbox, and starts it", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-trust-route-")));
    restore.push(() => rmSync(root, { recursive: true, force: true }));
    const dataDir = join(root, "data");
    const folder = join(root, "project");
    mkdirSync(dataDir);
    mkdirSync(folder);
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTailscaleAllow: [GUEST], inboxLaunch: { enabled: true } }));
    // The marker and HOME are this test's own: the sandbox's agents home is what keeps a click from the real config.
    const names = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_TEST_SANDBOX", "HOME", "PLANNOTATOR_INBOX_TAILSCALE"] as const;
    const previous = names.map((name) => [name, process.env[name]] as const);
    process.env.PLANNOTATOR_DATA_DIR = dataDir;
    process.env.PLANNOTATOR_TEST_SANDBOX = dataDir;
    process.env.HOME = join(root, "home");
    delete process.env.PLANNOTATOR_INBOX_TAILSCALE;
    restore.push(() => {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
    const server: InboxServer = await startInboxServer({ dataDir, binaryPath: null, version: "0.28.33", tailscale: scriptedTailscale(), publishTailnet: true, phones: false });
    restore.push(() => server.stop());
    const store = server.store;
    const project = store.ensureProject({ name: "project", root: folder });
    const launchId = "lch_0123456789ABCDEFGHJKMNPQRS";
    const record = { id: launchId, agent: "claude-code", session_ref: null, folder, scratch: false, started_at: new Date().toISOString() } as const;
    const thread = store.startPersonThread({ project_id: project.id, body: "Tidy the readme.", to: { host: "claude-code", session: `launch:${launchId}` }, idempotency_key: "trust-route", launch: record }).message;
    store.settleLaunch(thread.id, { error: { code: "untrusted", text: `${folder} isn't a trusted folder yet.`, at: new Date().toISOString() } });

    const listener = server.tailscale.listenerPort()!;
    const origin = `https://${MAGIC}:${server.port}`;
    const headers = (login: string) => ({ Host: `${MAGIC}:${server.port}`, "Tailscale-User-Login": login, Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" });
    const read = async (login: string) => ((await (await fetch(`http://127.0.0.1:${listener}/api/inbox/threads/${thread.id}`, { headers: headers(login) })).json()) as { run: { untrusted: boolean; trust?: { warning: string | null } } }).run;
    const click = (login: string) => fetch(`http://127.0.0.1:${listener}/api/inbox/launch/${launchId}/trust`, { method: "POST", headers: headers(login), body: JSON.stringify({ serverSession: server.serverSession }) });
    const sandboxConfig = join(dataDir, "agents-home", ".claude.json");

    const guestRun = await read(GUEST);
    expect(guestRun.untrusted).toBe(true);
    expect(guestRun.trust).toBeUndefined();
    const refused = await click(GUEST);
    expect([refused.status, ((await refused.json()) as { code?: string }).code]).toEqual([403, "owner_only"]);
    expect(existsSync(sandboxConfig)).toBe(false);
    expect(store.message(thread.id)!.launch!.error?.code).toBe("untrusted");

    expect((await read(OWNER)).trust).toEqual({ warning: null });
    const clicked = await click(OWNER);
    expect(clicked.status).toBe(200);
    // Inside the sandbox's own home, and only there.
    expect(JSON.parse(readFileSync(sandboxConfig, "utf8"))).toEqual({ projects: { [folder]: { hasTrustDialogAccepted: true } } });
    expect(store.message(thread.id)!.launch!.error?.code).not.toBe("untrusted");
  }, 30_000);

  test("the test guard refuses the home and its Claude folder, a home's own or the account's, and anything not scratch", () => {
    const { home: sandboxHome } = sandbox();
    const before = process.env.HOME;
    process.env.HOME = sandboxHome;
    restore.push(() => {
      process.env.HOME = before;
    });
    for (const home of [sandboxHome, accountHome()!]) {
      expect(() => refuseRealClaudeConfig(home, "test")).toThrow("own Claude Code config");
      expect(() => refuseRealClaudeConfig(`${home}/${CLAUDE_DIR}`, "test")).toThrow("own Claude Code config");
    }
    expect(() => refuseRealClaudeConfig("/opt/somewhere", "test")).toThrow("not a scratch folder");
    expect(refuseRealClaudeConfig(join(sandboxHome, "elsewhere"), "test")).toBe(join(sandboxHome, "elsewhere"));
  });
});
