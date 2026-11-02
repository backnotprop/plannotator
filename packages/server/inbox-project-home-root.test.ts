/**
 * The edges of the filesystem (audit items D4, D5): `/` and a home folder that
 * is itself a git work tree (dotfiles) never become a repository's project.
 * Real git repositories in temp folders; the home folder is a temp folder
 * passed to the code under test (`home`, `projectRootHome`), never HOME.
 * What can regress: every plain folder under a dotfiles home filed under the
 * home folder, a desktop app's shim at `/` making project "/", and a git that
 * runs past its time limit filing a folder into a home project for good.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startInboxServer, type InboxServer } from "./inbox";
import { createInboxProjectRoots, inboxGitRunner, resolveInboxProjectRoot, type InboxGitRunner } from "./inbox-project-root";

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

/** A home folder that is a git work tree (dotfiles), with plain folders and a real repository under it, and a dotfiles worktree beside it. */
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
    // A session started at home files under home, the plain folder, as for a home with no git.
    expect((await roots.resolve(w.home)).root).toBe(w.home);
    expect((await roots.resolve(join(w.proj, "src"))).root).toBe(w.proj);
    // A linked worktree of the dotfiles repository does not fold into home: its own folder.
    expect((await resolveInboxProjectRoot(w.dotWorktree, { home: w.home })).root).toBe(w.dotWorktree);
    // The same layout when that folder is not the home folder: a repository, which holds its subfolders.
    expect((await resolveInboxProjectRoot(w.notes, { home: null })).root).toBe(w.home);
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

    // git past its time limit for a new folder under home: refused, never filed under the home project (a repository on disk).
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
