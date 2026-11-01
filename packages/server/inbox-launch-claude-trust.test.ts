/**
 * Trust folder's Claude side (docs/agent-guides/inbox-launch.md, "Trusting a folder"). What each test guards: the
 * write changes one value and no other byte, keeps the mode and any link, and never replaces a file it can't read;
 * Claude's lock is taken, waited for, and survives two writers at once in separate processes; the key is the one
 * Claude Code uses (physical, NFC, a worktree's main checkout), and `claudeTrustsFolder` reads that key; the warning
 * counts what the folder turns on and says what it could not read; the owner's click goes through the real server,
 * into a sandboxed config, and a guest gets neither the button nor the route.
 *
 * Every config here is under a temp folder through `refuseRealClaudeConfig`; a real `~/.claude.json` is never read.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { accountHome, refuseRealClaudeConfig } from "../../tests/helpers/real-data-dir";
import { startInboxServer, type InboxServer } from "./inbox";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { claudeTrustsFolder, createClaudeLaunchHost } from "./inbox-launch-claude";
import { acceptClaudeTrust, claudeTrustKey, claudeTrustWarning } from "./inbox-launch-claude-trust";
import type { LaunchHostContext } from "./inbox-launch-host";

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
    writeFileSync(join(dir, ".claude/settings.json"), '{"model":"x","permissions":{"allow":["Bash"]}}');
    rmSync(join(dir, ".mcp.json"));
    expect(claudeTrustWarning([dir])).toBeNull();
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
  function host(home: string, configDir: string) {
    const context = { homeDir: home, platform: "darwin", dataDir: join(home, "data"), shell: () => null, ownEnv: () => ({ CLAUDE_CONFIG_DIR: configDir }), displayFolder: (path: string) => path } as unknown as LaunchHostContext;
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
    expect(offer.warning).toBe("This folder has 1 hook and 1 MCP server that will run once you trust it.");
    await offer.accept();
    expect(Object.keys(JSON.parse(readFileSync(config, "utf8")).projects)).toEqual([scratchRoot]);
  });

  test("the home folder gets no offer: Claude never saves trust there", () => {
    const { home, configDir } = sandbox();
    expect(host(home, configDir).trustOffer(launch(home))).toBeNull();
  });

  test("a failed write says which file and why, for the run line", async () => {
    const { root, home, configDir, config } = sandbox();
    writeFileSync(config, "not json");
    await expect(host(home, configDir).trustOffer(launch(root))!.accept()).rejects.toThrow(`Could not update ${config}: it is not plain JSON. Nothing was changed.`);
    expect(readFileSync(config, "utf8")).toBe("not json");
  });
});

describe("through a real server", () => {
  const MAGIC = "macbook-pro.tail0000.ts.net";
  const OWNER = "owner@example.com";
  const GUEST = "guest@example.com";
  /** `tailscale` as a script: the owner, serve status, serve on and off. */
  function scriptedTailscale(): TailscaleRunner {
    const serve = new Map<number, string>();
    return (args) => {
      const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
      if (args[0] === "status") return ok(JSON.stringify({ Self: { DNSName: `${MAGIC}.`, UserID: 42 }, User: { "42": { ID: 42, LoginName: OWNER, DisplayName: "Owner" } } }));
      if (args[1] === "status") {
        const TCP = Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }]));
        const Web = Object.fromEntries([...serve].map(([p, proxy]) => [`${MAGIC}:${p}`, { Handlers: { "/": { Proxy: proxy } } }]));
        return ok(serve.size === 0 ? "{}" : JSON.stringify({ TCP, Web }));
      }
      const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
      if (args.includes("off")) {
        serve.delete(httpsPort);
        return ok();
      }
      serve.set(httpsPort, args.at(-1)!);
      return ok(`https://${MAGIC}:${httpsPort}/\n|-- proxy ${args.at(-1)}\n`);
    };
  }

  test("a guest on the allow list gets no offer and a refused route; the owner over the tailnet writes, into the sandbox, and starts it", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-trust-route-")));
    restore.push(() => rmSync(root, { recursive: true, force: true }));
    const dataDir = join(root, "data");
    const folder = join(root, "project");
    mkdirSync(dataDir);
    mkdirSync(folder);
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTailscaleAllow: [GUEST], inboxLaunch: { enabled: true } }));
    const previous = { data: process.env.PLANNOTATOR_DATA_DIR, ts: process.env.PLANNOTATOR_INBOX_TAILSCALE };
    process.env.PLANNOTATOR_DATA_DIR = dataDir;
    delete process.env.PLANNOTATOR_INBOX_TAILSCALE;
    restore.push(() => {
      if (previous.data === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = previous.data;
      if (previous.ts !== undefined) process.env.PLANNOTATOR_INBOX_TAILSCALE = previous.ts;
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
