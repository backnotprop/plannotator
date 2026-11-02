/**
 * The one-time fold at Inbox startup (inbox-checkout-folders.ts; the owner, 2026-11-02, on #2526): the folder
 * project an earlier Inbox made for a checkouts folder (`appnotes`, whose `worktrees/` holds the repository's
 * checkouts) goes into the repository's project through Combine projects' own write, once. Real git
 * repositories and worktrees in temp folders; a real Inbox on loopback under a temp data dir for the whole
 * start; the pass itself over a store for the cases around it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxProjectDisplayName } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { startInboxServer, type InboxServer } from "./inbox";
import { foldCheckoutFolderProjects, INBOX_CHECKOUT_FOLDS_FILE, INBOX_CHECKOUT_FOLDS_MAX_STARTS } from "./inbox-checkout-folders";
import type { InboxGitRunner } from "./inbox-project-root";

const scratch: string[] = [];
const servers: InboxServer[] = [];
const ENV_KEYS = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-c", "init.defaultBranch=main", ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
}

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-folds-")));
  scratch.push(root);
  return root;
}

/** A repository with one commit at `path`. */
function repository(path: string): string {
  git(tmpdir(), "init", "-q", path);
  writeFileSync(join(path, "README.md"), "x\n");
  git(path, "add", ".");
  git(path, "commit", "-qm", "init");
  return realpathSync(path);
}

/** The owner's layout: `appnotes` (notes) with `worktrees/main` (the main checkout) and a linked worktree. */
function appnotes(root: string) {
  const folder = join(root, "workspaces", "projects", "appnotes");
  mkdirSync(join(folder, "worktrees"), { recursive: true });
  writeFileSync(join(folder, "DESIGN.md"), "# Design\n");
  const main = repository(join(folder, "worktrees", "main"));
  const branch = join(folder, "worktrees", "agent-pr-plan-box");
  git(main, "worktree", "add", "-q", branch, "-b", "agent-pr-plan-box");
  return { folder: realpathSync(folder), main, branch: realpathSync(branch), dataDir: join(root, "data") };
}

const AGENT = (session: string) => ({ kind: "agent" as const, host: "claude-code", session, name: "Claude Code" });

/** Each row as the person sees it, without the project it is filed under. */
const rowsOf = (store: InboxStore) =>
  Object.fromEntries(store.listRows().map(({ thread_id, unread, section, subject, message_count, resolved_at }) => [thread_id, { unread, section, subject, message_count, resolved_at }]));

async function until(check: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("an old store with the folder project and the repository's becomes one project with every thread, once", async () => {
  const { folder, main, dataDir } = appnotes(tempRoot());
  // What an Inbox before the fold wrote: the repository's project, and a folder project beside it.
  const before = InboxStore.open(dataDir);
  const repo = before.ensureProject({ name: "main", root: main });
  before.renameProject(repo.id, "appnotes");
  const old = before.ensureProject({ name: "appnotes", root: folder });
  const fromCheckout = before.sendMessage({ project_id: repo.id, author: AGENT("ses_wt"), body: "From a checkout." }).message;
  const asked = before.sendMessage({ project_id: old.id, author: AGENT("ses_folder"), body: "Ship it?\n\n:::question\nShip it?\n- Yes\n- No\n:::" }).message;
  const read = before.sendMessage({ project_id: old.id, author: AGENT("ses_folder_2"), body: "Notes updated." }).message;
  before.markRead(read.thread_id, true);
  const later = new Date(Date.now() + 86_400_000).toISOString();
  before.setSnooze(fromCheckout.thread_id, later);
  const rows = rowsOf(before);
  const other = before.ensureProject({ name: "docs-site", root: realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-folds-docs-"))) });
  scratch.push(other.root);

  const server = await startInboxServer({ dataDir, phones: false, debug: true });
  servers.push(server);
  await until(() => server.store.canonicalProjectId(old.id) === repo.id, "the fold");
  await until(() => existsSync(join(server.store.dir, INBOX_CHECKOUT_FOLDS_FILE)), "the marker");
  // One project where there were two, with the repository's name; the other project is untouched.
  expect(server.store.listProjects().map((p) => p.id).sort()).toEqual([repo.id, other.id].sort());
  expect(server.store.project(repo.id)?.display_name).toBe("appnotes");
  expect(server.store.project(other.id)?.merged_into).toBeUndefined();
  // Every thread under it, each as it was: read state, sections, the snooze.
  const after = server.store.listRows();
  expect(new Set(after.map((row) => row.project.id))).toEqual(new Set([repo.id]));
  expect(after.map((row) => row.thread_id).sort()).toEqual([fromCheckout.thread_id, asked.thread_id, read.thread_id].sort());
  expect(rowsOf(server.store)).toEqual(rows);
  expect(server.store.snoozes().map((s) => s.thread_id)).toEqual([fromCheckout.thread_id]);
  // One debug line for it.
  const debug = readFileSync(join(server.store.dir, "debug.log"), "utf8").split("\n").filter((line) => line.includes('"project_folded"'));
  expect(debug.length).toBe(1);
  expect(JSON.parse(debug[0]!)).toMatchObject({ ev: "project_folded", project: old.id, into: repo.id, root: folder, into_root: main });
  const projectLines = readFileSync(join(server.store.dir, "projects", old.key, "project.json"), "utf8");
  server.stop();
  servers.splice(servers.indexOf(server), 1);

  // A second start does nothing: no new project line, no new debug line, the same one project.
  const again = await startInboxServer({ dataDir, phones: false, debug: true });
  servers.push(again);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(readFileSync(join(again.store.dir, "projects", old.key, "project.json"), "utf8")).toBe(projectLines);
  expect(readFileSync(join(again.store.dir, "debug.log"), "utf8").split("\n").filter((line) => line.includes('"project_folded"')).length).toBe(1);
  expect(again.store.listProjects().map((p) => p.id).sort()).toEqual([repo.id, other.id].sort());
});

test("a folder whose worktrees hold checkouts of two repositories is untouched", async () => {
  const root = tempRoot();
  const { folder, main, dataDir } = appnotes(root);
  const other = repository(join(root, "other"));
  git(other, "worktree", "add", "-q", join(folder, "worktrees", "other-fix"), "-b", "fix");
  const store = InboxStore.open(dataDir);
  const repo = store.ensureProject({ name: "main", root: main });
  const otherProject = store.ensureProject({ name: "other", root: other });
  const old = store.ensureProject({ name: "appnotes", root: folder });
  store.sendMessage({ project_id: old.id, author: AGENT("ses_folder"), body: "Notes." });
  const result = await foldCheckoutFolderProjects({ store });
  expect(result).toEqual({ folded: [], done: true });
  for (const project of [repo, otherProject, old]) expect(store.canonicalProjectId(project.id)).toBe(project.id);
  expect(store.project(old.id)?.merged_into).toBeUndefined();
});

test("no repository project yet: the folder project is left as it is and the next start looks again", async () => {
  const { folder, main, dataDir } = appnotes(tempRoot());
  const store = InboxStore.open(dataDir);
  const old = store.ensureProject({ name: "appnotes", root: folder });
  expect(await foldCheckoutFolderProjects({ store })).toEqual({ folded: [], done: false });
  expect(stateOf(store)).toMatchObject({ starts: 1, done: false });
  // A session in a checkout makes the repository's project; the next pass folds the folder into it.
  const repo = store.ensureProject({ name: "main", root: main });
  expect(await foldCheckoutFolderProjects({ store })).toEqual({ folded: [{ project: old.id, into: repo.id }], done: true });
});

test("without the marker the pass is safe to repeat; a git that does not answer leaves it for the next start", async () => {
  const { folder, main, dataDir } = appnotes(tempRoot());
  const store = InboxStore.open(dataDir);
  const repo = store.ensureProject({ name: "main", root: main });
  const old = store.ensureProject({ name: "appnotes", root: folder });
  const silent: InboxGitRunner = async () => null;
  expect(await foldCheckoutFolderProjects({ store, git: silent })).toEqual({ folded: [], done: false });
  expect(store.canonicalProjectId(old.id)).toBe(old.id);
  expect((await foldCheckoutFolderProjects({ store })).folded).toEqual([{ project: old.id, into: repo.id }]);
  const lines = readFileSync(join(store.dir, "projects", old.key, "project.json"), "utf8");
  rmSync(join(store.dir, INBOX_CHECKOUT_FOLDS_FILE));
  expect(await foldCheckoutFolderProjects({ store })).toEqual({ folded: [], done: true });
  expect(readFileSync(join(store.dir, "projects", old.key, "project.json"), "utf8")).toBe(lines);
});

test("a folder project the person split from a combine is not folded again", async () => {
  const { folder, main, dataDir } = appnotes(tempRoot());
  const store = InboxStore.open(dataDir);
  const repo = store.ensureProject({ name: "main", root: main });
  const old = store.ensureProject({ name: "appnotes", root: folder });
  store.combineProject(old.id, repo.id);
  store.combineProject(old.id, null);
  expect(await foldCheckoutFolderProjects({ store })).toEqual({ folded: [], done: true });
  expect(store.canonicalProjectId(old.id)).toBe(old.id);
});

test("a folder project for a plain subfolder of the holder (`appnotes/notes`) is folded too; one outside the walk is not", async () => {
  const { folder, main, dataDir } = appnotes(tempRoot());
  const notes = join(folder, "notes");
  const far = join(folder, "a", "b", "c", "d");
  mkdirSync(notes);
  mkdirSync(far, { recursive: true });
  const store = InboxStore.open(dataDir);
  const repo = store.ensureProject({ name: "main", root: main });
  const sub = store.ensureProject({ name: "notes", root: realpathSync(notes) });
  const outside = store.ensureProject({ name: "d", root: realpathSync(far) });
  expect(await foldCheckoutFolderProjects({ store })).toEqual({ folded: [{ project: sub.id, into: repo.id }], done: true });
  expect(store.canonicalProjectId(outside.id)).toBe(outside.id);
  // The repository project reads its repository's name for agents too.
  expect(store.listProjects().find((p) => p.id === repo.id)?.name).toBe("appnotes");
});

test("~/work, a folder of repositories with a worktrees folder of one of them, is never folded", async () => {
  const root = tempRoot();
  const work = join(root, "work");
  mkdirSync(join(work, "worktrees"), { recursive: true });
  const api = repository(join(work, "api"));
  repository(join(work, "web"));
  git(api, "worktree", "add", "-q", join(work, "worktrees", "api-feat"), "-b", "api-feat");
  const store = InboxStore.open(join(root, "data"));
  const apiProject = store.ensureProject({ name: "api", root: api });
  const workProject = store.ensureProject({ name: "work", root: realpathSync(work) });
  expect(await foldCheckoutFolderProjects({ store })).toEqual({ folded: [], done: true });
  expect(store.canonicalProjectId(workProject.id)).toBe(workProject.id);
  expect(store.canonicalProjectId(apiProject.id)).toBe(apiProject.id);
});

test("projects already combined either way are left as they are, and a git that times out on the checkout folds nothing", async () => {
  const { folder, main, dataDir } = appnotes(tempRoot());
  const store = InboxStore.open(dataDir);
  const repo = store.ensureProject({ name: "main", root: main });
  const old = store.ensureProject({ name: "appnotes", root: folder });
  // The person combined the repository into the folder project: the fold does not turn it around.
  store.combineProject(repo.id, old.id);
  const real: InboxGitRunner = async (args, cwd) => {
    const result = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
    return { exitCode: result.exitCode, stdout: result.stdout.toString() };
  };
  expect(await foldCheckoutFolderProjects({ store, git: real })).toEqual({ folded: [], done: true });
  expect(store.canonicalProjectId(repo.id)).toBe(old.id);
  // A fresh store where the checkout's git runs past the time limit (the folder's own answers): nothing folds, the next start asks again.
  const second = appnotes(tempRoot());
  const other = InboxStore.open(second.dataDir);
  other.ensureProject({ name: "main", root: second.main });
  const plain = other.ensureProject({ name: "appnotes", root: second.folder });
  const slow: InboxGitRunner = async (args, cwd) => (cwd === second.main ? null : real(args, cwd));
  expect(await foldCheckoutFolderProjects({ store: other, git: slow })).toEqual({ folded: [], done: false });
  expect(other.canonicalProjectId(plain.id)).toBe(plain.id);
});

const stateOf = (store: InboxStore) => JSON.parse(readFileSync(join(store.dir, INBOX_CHECKOUT_FOLDS_FILE), "utf8")) as { since: string; starts: number; done: boolean };

test("an Undo of a combine the other way (the repository into the folder) is not redone", async () => {
  const { folder, main, dataDir } = appnotes(tempRoot());
  const store = InboxStore.open(dataDir);
  const repo = store.ensureProject({ name: "main", root: main });
  const old = store.ensureProject({ name: "appnotes", root: folder });
  store.combineProject(repo.id, old.id);
  store.combineProject(repo.id, null);
  expect(store.project(old.id)?.separated_from).toBeUndefined();
  expect(await foldCheckoutFolderProjects({ store })).toEqual({ folded: [], done: true });
  expect(store.canonicalProjectId(old.id)).toBe(old.id);
  expect(store.canonicalProjectId(repo.id)).toBe(repo.id);
});

test("~/work holding web/ right in it, client-docs/2024 and worktrees/api with api-feat: neither folder project folds; the owner's appnotes still does", async () => {
  const root = tempRoot();
  const work = join(root, "work");
  const notes = join(work, "client-docs", "2024");
  mkdirSync(notes, { recursive: true });
  mkdirSync(join(work, "worktrees"));
  const api = repository(join(work, "worktrees", "api"));
  git(api, "worktree", "add", "-q", join(work, "worktrees", "api-feat"), "-b", "api-feat");
  repository(join(work, "web"));
  const store = InboxStore.open(join(root, "data"));
  store.ensureProject({ name: "api", root: api });
  const workProject = store.ensureProject({ name: "work", root: realpathSync(work) });
  const notesProject = store.ensureProject({ name: "2024", root: realpathSync(notes) });
  expect(await foldCheckoutFolderProjects({ store })).toEqual({ folded: [], done: true });
  for (const project of [workProject, notesProject]) expect(store.canonicalProjectId(project.id)).toBe(project.id);
  // The appnotes layout (no checkout right in the folder) folds as before.
  const owner = appnotes(tempRoot());
  const other = InboxStore.open(owner.dataDir);
  const repo = other.ensureProject({ name: "main", root: owner.main });
  const old = other.ensureProject({ name: "appnotes", root: owner.folder });
  expect((await foldCheckoutFolderProjects({ store: other })).folded).toEqual([{ project: old.id, into: repo.id }]);
});

test("a folder project the person renamed stays apart", async () => {
  const { folder, main, dataDir } = appnotes(tempRoot());
  const store = InboxStore.open(dataDir);
  store.ensureProject({ name: "main", root: main });
  const old = store.ensureProject({ name: "appnotes", root: folder });
  store.renameProject(old.id, "Appnotes notes");
  expect(await foldCheckoutFolderProjects({ store })).toEqual({ folded: [], done: true });
  expect(store.canonicalProjectId(old.id)).toBe(old.id);
});

test("this user's home (injected) with a worktrees folder of one repository is never folded", async () => {
  const root = tempRoot();
  const home = join(root, "me");
  mkdirSync(join(home, "worktrees"), { recursive: true });
  const main = repository(join(home, "worktrees", "main"));
  const store = InboxStore.open(join(root, "data"));
  store.ensureProject({ name: "main", root: main });
  const homeProject = store.ensureProject({ name: "me", root: realpathSync(home) });
  expect(await foldCheckoutFolderProjects({ store, home: realpathSync(home) })).toEqual({ folded: [], done: true });
  expect(store.canonicalProjectId(homeProject.id)).toBe(homeProject.id);
  // Not this user's home: the same folder folds, so the home is what kept it apart.
  rmSync(join(store.dir, INBOX_CHECKOUT_FOLDS_FILE));
  expect((await foldCheckoutFolderProjects({ store, home: null })).folded).toHaveLength(1);
});

test("a done pass is final: a folder that becomes foldable later is not folded by a later start", async () => {
  const root = tempRoot();
  const folder = join(root, "appnotes");
  mkdirSync(folder);
  const store = InboxStore.open(join(root, "data"));
  const old = store.ensureProject({ name: "appnotes", root: realpathSync(folder) });
  expect(await foldCheckoutFolderProjects({ store })).toEqual({ folded: [], done: true });
  mkdirSync(join(folder, "worktrees"));
  const main = repository(join(folder, "worktrees", "main"));
  store.ensureProject({ name: "main", root: main });
  expect(await foldCheckoutFolderProjects({ store })).toEqual({ folded: [], done: true });
  expect(store.canonicalProjectId(old.id)).toBe(old.id);
  // Without the state file the same store folds: the file is what stopped it.
  rmSync(join(store.dir, INBOX_CHECKOUT_FOLDS_FILE));
  expect((await foldCheckoutFolderProjects({ store })).folded).toEqual([{ project: old.id, into: store.projectByRoot(main)!.id }]);
});

test("pending ends: only projects older than the first pass count, and the pass gives up after its last start", async () => {
  const { folder, dataDir } = appnotes(tempRoot());
  const store = InboxStore.open(dataDir);
  store.ensureProject({ name: "appnotes", root: folder });
  const first = new Date(Date.now() + 1_000);
  for (let start = 1; start < INBOX_CHECKOUT_FOLDS_MAX_STARTS; start += 1) {
    expect(await foldCheckoutFolderProjects({ store, now: () => first })).toEqual({ folded: [], done: false });
    expect(stateOf(store)).toMatchObject({ since: first.toISOString(), starts: start, done: false });
  }
  expect(await foldCheckoutFolderProjects({ store })).toEqual({ folded: [], done: true });
  // A folder project made after the first pass is not an old duplicate (rule 4 files new sessions right): not a candidate.
  const second = appnotes(tempRoot());
  const other = InboxStore.open(second.dataDir);
  other.ensureProject({ name: "main", root: second.main });
  const newer = other.ensureProject({ name: "appnotes", root: second.folder });
  const past = new Date(Date.parse(newer.created_at) - 60_000).toISOString();
  writeFileSync(join(other.dir, INBOX_CHECKOUT_FOLDS_FILE), JSON.stringify({ v: 1, since: past, starts: 1, done: false, folded: [] }));
  expect(await foldCheckoutFolderProjects({ store: other })).toEqual({ folded: [], done: true });
  expect(other.canonicalProjectId(newer.id)).toBe(newer.id);
});

test("a folder project the person combined into another project stays there", async () => {
  const { folder, main, dataDir } = appnotes(tempRoot());
  const store = InboxStore.open(dataDir);
  store.ensureProject({ name: "main", root: main });
  const old = store.ensureProject({ name: "appnotes", root: folder });
  const elsewhere = store.ensureProject({ name: "notes", root: tempRoot() });
  store.combineProject(old.id, elsewhere.id);
  expect(await foldCheckoutFolderProjects({ store })).toEqual({ folded: [], done: true });
  expect(store.canonicalProjectId(old.id)).toBe(elsewhere.id);
});

test("a rename made while git answers counts: the folder project is read again right before the combine", async () => {
  const { folder, main, dataDir } = appnotes(tempRoot());
  const store = InboxStore.open(dataDir);
  store.ensureProject({ name: "main", root: main });
  const old = store.ensureProject({ name: "appnotes", root: folder });
  const renaming: InboxGitRunner = async (args, cwd) => {
    if (inboxProjectDisplayName(store.project(old.id)!) === null) store.renameProject(old.id, "Appnotes notes");
    const result = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
    return { exitCode: result.exitCode, stdout: result.stdout.toString() };
  };
  expect(await foldCheckoutFolderProjects({ store, git: renaming })).toEqual({ folded: [], done: true });
  expect(store.canonicalProjectId(old.id)).toBe(old.id);
});
