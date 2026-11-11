import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { accountHome } from "../../tests/helpers/real-data-dir";
import { basename, join, parse } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { startInboxServer, type InboxServer } from "./inbox";
import { INBOX_CHECKOUT_FOLDS_FILE } from "./inbox-checkout-folders";
import {
  createInboxProjectRoots,
  guessableProjects,
  inboxGitRunner,
  isHomeOrRootFolder,
  isHomeOrRootShape,
  resolveCheckoutsFolder,
  resolveInboxProjectRoot,
  type InboxGitRunner,
} from "./inbox-project-root";

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const scratch: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
const ENV_KEYS = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-c", "init.defaultBranch=main", ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
}

function repository(folder: string): string {
  mkdirSync(folder, { recursive: true });
  git(folder, "init", "-q");
  git(folder, "commit", "-q", "--allow-empty", "-m", "init");
  return folder;
}

function dotfilesHome() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-home-")));
  scratch.push(root);
  const home = repository(join(root, "me"));
  const notes = join(home, "notes", "2026");
  mkdirSync(notes, { recursive: true });
  const proj = repository(join(home, "code", "proj"));
  mkdirSync(join(proj, "src"));
  const dotWorktree = join(root, "dotfiles-wt");
  git(home, "worktree", "add", "-q", dotWorktree, "-b", "wt");
  return { root, home, notes, proj, dotWorktree, dataDir: join(root, "data") };
}

describe("a home folder that is a git work tree (dotfiles)", () => {
  test("is no repository's project: a plain folder under it is its own, as under a plain home; real repositories are unchanged", async () => {
    const w = dotfilesHome();
    const roots = createInboxProjectRoots({ home: w.home });
    expect((await roots.resolve(w.notes)).root).toBe(w.notes);
    expect((await roots.resolve(join(w.home, "notes"))).root).toBe(join(w.home, "notes"));
    expect((await roots.resolve(w.home)).root).toBe(w.home);
    expect((await roots.resolve(join(w.proj, "src"))).root).toBe(w.proj);
    expect((await resolveInboxProjectRoot(w.dotWorktree, { home: w.home })).root).toBe(w.dotWorktree);
    expect((await resolveInboxProjectRoot(w.notes, { home: null })).root).toBe(w.home);
  });
});

describe("a dotfiles home and rule 4", () => {
  function appnotesUnder(home: string) {
    const folder = join(home, "workspaces", "appnotes");
    mkdirSync(join(folder, "notes"), { recursive: true });
    const main = repository(join(folder, "worktrees", "main"));
    return { folder, main };
  }

  test("a checkouts folder under a dotfiles home files under its repository, and the startup fold folds its old project", async () => {
    const w = dotfilesHome();
    const { folder, main } = appnotesUnder(w.home);
    expect((await resolveInboxProjectRoot(folder, { home: w.home })).root).toBe(main);
    expect((await resolveInboxProjectRoot(join(folder, "notes"), { home: w.home })).root).toBe(main);
    expect(await resolveCheckoutsFolder(folder, { home: w.home })).toEqual({ root: main, settled: true });
    const before = InboxStore.open(w.dataDir);
    const repo = before.ensureProject({ name: "main", root: main });
    const old = before.ensureProject({ name: "appnotes", root: folder });
    const server = await startInboxServer({ dataDir: w.dataDir, phones: false, projectRootHome: w.home });
    servers.push(server);
    await until(() => server.store.canonicalProjectId(old.id) === repo.id);
  });

  test("a home folder with a worktrees folder is never a holder nor folded, with the home the server was given", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-home-")));
    scratch.push(root);
    const home = join(root, "me");
    const main = repository(join(home, "worktrees", "main"));
    expect((await resolveInboxProjectRoot(home, { home })).root).toBe(home);
    expect(await resolveCheckoutsFolder(home, { home })).toEqual({ root: null, settled: true });
    const dataDir = join(root, "data");
    const before = InboxStore.open(dataDir);
    before.ensureProject({ name: "main", root: main });
    const atHome = before.ensureProject({ name: "me", root: home });
    const server = await startInboxServer({ dataDir, phones: false, projectRootHome: home });
    servers.push(server);
    await until(() => existsSync(join(server.store.dir, INBOX_CHECKOUT_FOLDS_FILE)));
    expect(server.store.project(atHome.id)?.merged_into).toBeUndefined();
  });

  test("only the exact home and `/` stop a git toplevel: a repository at a home-shaped path stays a repository", () => {
    expect(isHomeOrRootFolder("/home/dev", null, { shape: false })).toBe(false);
    expect(isHomeOrRootFolder("/home/dev", "/home/dev", { shape: false })).toBe(true);
    expect(isHomeOrRootFolder("/", null, { shape: false })).toBe(true);
    expect(isHomeOrRootFolder("/home/dev", null)).toBe(true);
  });

  const shapedFolder = (() => {
    try {
      const real = realpathSync(accountHome()!);
      return isHomeOrRootShape(real) && real !== parse(real).root ? real : null;
    } catch {
      return null;
    }
  })();

  test("a home-shaped path exists on this runner for the tests below", () => {
    expect(shapedFolder).not.toBeNull();
  });

  test.if(shapedFolder !== null)("the resolver keeps a repository whose toplevel only looks like a home folder", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-home-")));
    scratch.push(root);
    const shaped = shapedFolder!;
    const git: InboxGitRunner = async () => ({ exitCode: 0, stdout: `${shaped}\n${shaped}/.git\n${shaped}/.git\n` });
    expect((await resolveInboxProjectRoot(root, { git, home: null })).root).toBe(shaped);
  });

  test.if(shapedFolder !== null)("a linked worktree folds into a main checkout that only looks like a home folder", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-home-")));
    scratch.push(root);
    const shaped = shapedFolder!;
    const worktree = join(root, "wt");
    const common = join(root, "repo.git");
    mkdirSync(worktree);
    mkdirSync(join(common, "worktrees", "wt"), { recursive: true });
    const git: InboxGitRunner = async (args, cwd) => {
      const ask = `${args.join(" ")} @ ${cwd}`;
      if (ask === `rev-parse --show-toplevel --git-dir --git-common-dir @ ${worktree}`) return { exitCode: 0, stdout: `${worktree}\n${common}/worktrees/wt\n${common}\n` };
      if (ask === `rev-parse --is-bare-repository @ ${common}`) return { exitCode: 0, stdout: "false\n" };
      if (ask === `rev-parse --show-toplevel @ ${common}`) return { exitCode: 0, stdout: `${shaped}\n` };
      if (ask === `rev-parse --show-toplevel --git-common-dir @ ${shaped}`) return { exitCode: 0, stdout: `${shaped}\n${common}\n` };
      return { exitCode: 128, stdout: "" };
    };
    expect(await resolveInboxProjectRoot(worktree, { git, home: null })).toMatchObject({ root: shaped, worktree });
    expect(await resolveInboxProjectRoot(worktree, { git, home: shaped })).toMatchObject({ root: worktree, worktree: null });
  });

  test("a slow git may file into a repository project at a home-shaped path, never at the exact home or `/`", () => {
    const projects = [{ root: "/home/dev" }, { root: "/Users/dev" }, { root: "/home/me" }, { root: "/" }, { root: "/home/dev/plain" }];
    const withGit = new Set(["/home/dev", "/Users/dev", "/home/me", "/"]);
    expect(guessableProjects(projects, "/home/me", (root) => withGit.has(root)).map((project) => project.root)).toEqual(["/home/dev", "/Users/dev"]);
  });
});

describe("a filesystem root", () => {
  test("is never a project: `/` names the home folder, and is refused when there is no home folder to use", async () => {
    const w = dotfilesHome();
    const atRoot = await resolveInboxProjectRoot("/", { home: w.home });
    expect([atRoot.root, atRoot.folder, atRoot.name]).toEqual([w.home, w.home, basename(w.home)]);
    expect((await createInboxProjectRoots({ home: w.home }).resolve("/")).root).toBe(w.home);
    for (const home of [null, "/"]) {
      await expect(resolveInboxProjectRoot("/", { home })).rejects.toMatchObject({ code: "validation_error" });
    }
  });
});

describe("the Inbox at the edges", () => {
  test("an MCP client started at `/` files under the home folder; a send under a dotfiles home files under its own folder; a git timeout never files into the home project", async () => {
    const w = dotfilesHome();
    const real = inboxGitRunner();
    let slow = false;
    const git: InboxGitRunner = async (args, cwd) => {
      if (!slow) return real(args, cwd);
      await Bun.sleep(20);
      return null;
    };
    const server = await startInboxServer({ dataDir: w.dataDir, phones: false, projectRootGit: git, projectRootHome: w.home });
    servers.push(server);
    const client = new Client({ name: "inbox-project-home-root-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
    clients.push(client);
    const send = async (args: Record<string, unknown>) =>
      (await client.callTool({ name: "send_message", arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };

    const fromRoot = await send({ project_path: "/", body: "From a desktop app.", agent_session: "ses_desktop" });
    expect(fromRoot.isError).toBeFalsy();
    expect(fromRoot.structuredContent.project.root).toBe(w.home);
    const fromNotes = await send({ project_path: w.notes, body: "Meeting notes.", agent_session: "ses_notes" });
    expect(fromNotes.structuredContent.project.root).toBe(w.notes);

    slow = true;
    const later = join(w.home, "scratch");
    mkdirSync(later);
    const guessed = await send({ project_path: later, body: "From scratch.", agent_session: "ses_scratch" });
    expect(guessed.isError).toBe(true);
    expect(guessed.content[0]!.text).toStartWith("project_unresolved:");
    expect(server.store.listProjects().map((project) => project.root).sort()).toEqual([w.home, w.notes].sort());
    expect(server.store.listProjects().some((project) => project.root === "/")).toBe(false);
  });
});
