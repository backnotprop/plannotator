import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { INBOX_BRIDGE_POLL_PATH } from "@plannotator/shared/inbox/connection";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { startInboxServer, type InboxServer } from "./inbox";
import { inboxGitRunner, type InboxGitRunner } from "./inbox-project-root";

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

function png(): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0]);
  return bytes;
}

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-worktree-")));
  scratch.push(root);
  const main = join(root, "api");
  mkdirSync(join(main, "docs"), { recursive: true });
  git(root, "init", "-q", main);
  writeFileSync(join(main, "docs", "main-shot.png"), png());
  git(main, "add", ".");
  git(main, "commit", "-qm", "init");
  const worktree = join(root, "api-wt");
  git(main, "worktree", "add", "-q", worktree, "-b", "feature");
  mkdirSync(join(worktree, "shots"), { recursive: true });
  mkdirSync(join(worktree, "notes"), { recursive: true });
  writeFileSync(join(worktree, "shots", "after.png"), png());
  writeFileSync(join(worktree, "notes", "plan.md"), "# Plan\n");
  writeFileSync(join(root, "secret.png"), png());
  return { root, main, worktree, dataDir: join(root, "data") };
}

async function start(dataDir: string, projectRootGit?: InboxGitRunner): Promise<InboxServer> {
  const server = await startInboxServer({ dataDir, phones: false, ...(projectRootGit ? { projectRootGit } : {}) });
  servers.push(server);
  return server;
}

async function agent(server: InboxServer): Promise<Client> {
  const client = new Client({ name: "inbox-worktree-projects-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return client;
}

async function send(client: Client, args: Record<string, unknown>): Promise<Record<string, any>> {
  const result = (await client.callTool({ name: "send_message", arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };
  if (result.isError) throw new Error(result.content[0]!.text);
  return result.structuredContent;
}

function image(server: InboxServer, messageId: string, path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/inbox/messages/${messageId}/image?path=${encodeURIComponent(path)}`);
}

test("a message from a linked worktree lands in the main repository's project and keeps the worktree as its base", async () => {
  const { main, worktree, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const fromMain = await send(client, { project_path: main, body: "From the main checkout.", agent_session: "ses_main" });
  const fromWorktree = await send(client, { project_path: worktree, body: "From the worktree.", agent_session: "ses_wt" });

  expect(fromWorktree.project).toEqual(fromMain.project);
  expect(fromWorktree.project.root).toBe(main);
  expect(server.store.listProjects().map((p) => p.root)).toEqual([main]);
  expect(server.store.message(fromWorktree.message_id)?.base_path).toBe(worktree);
  const deep = await send(client, { project_path: join(worktree, "notes"), body: "From notes.", agent_session: "ses_wt" });
  expect(deep.project.id).toBe(fromMain.project.id);
  expect(server.store.message(deep.message_id)?.base_path).toBe(join(worktree, "notes"));
  expect(server.store.message(fromMain.message_id)?.base_path).toBeUndefined();
});

test("a linked worktree of another repository replying into a thread keeps the worktree as its base, on a host that sends no folder", async () => {
  const { root, main, dataDir } = world();
  const other = join(root, "other");
  mkdirSync(other);
  writeFileSync(join(other, "README.md"), "# other\n");
  git(root, "init", "-q", other);
  git(other, "add", ".");
  git(other, "commit", "-qm", "init");
  const otherTree = join(root, "other-wt");
  git(other, "worktree", "add", "-q", otherTree, "-b", "feature");
  const server = await start(dataDir);
  const client = await agent(server);
  const asked = await send(client, { project_path: main, body: "Which one?", agent_session: "ses_main" });
  const fromTree = await send(client, { project_path: otherTree, reply_to: asked.message_id, body: "From my worktree.", agent_session: "ses_wt" });
  const fromItsMain = await send(client, { project_path: other, reply_to: asked.message_id, body: "From its main checkout.", agent_session: "ses_other" });
  expect(server.store.message(fromTree.message_id)?.base_path).toBe(otherTree);
  expect(server.store.message(fromTree.message_id)?.from_project?.root).toBe(other);
  expect(server.store.message(fromItsMain.message_id)?.base_path).toBeUndefined();
});

test("images relative to the worktree resolve there, and from anywhere else on this computer", async () => {
  const { main, worktree, dataDir } = world();
  const server = await start(dataDir);
  const sent = await send(await agent(server), {
    project_path: worktree,
    body: `![after](shots/after.png) ![main](${join(main, "docs", "main-shot.png")}) ![up](../secret.png)`,
    agent_session: "ses_wt",
  });

  const after = await image(server, sent.message_id, "shots/after.png");
  expect(after.status).toBe(200);
  expect(new Uint8Array(await after.arrayBuffer())).toEqual(png());
  expect((await image(server, sent.message_id, join(main, "docs", "main-shot.png"))).status).toBe(200);
  expect((await image(server, sent.message_id, "../secret.png")).status).toBe(200);

  git(main, "worktree", "remove", "--force", worktree);
  expect((await image(server, sent.message_id, "shots/after.png")).status).toBe(404);
});

test("a worktree inside a hidden folder (as Codex and Claude Code keep theirs) still shows the images sent from it", async () => {
  const { root, main, dataDir } = world();
  // Outside the project's root, under a hidden folder: `.codex/worktrees/<id>`.
  const hidden = join(root, ".codex", "worktrees", "wt1");
  mkdirSync(join(root, ".codex", "worktrees"), { recursive: true });
  git(main, "worktree", "add", "-q", hidden, "-b", "codex-wt");
  mkdirSync(join(hidden, "shots", ".cache"), { recursive: true });
  writeFileSync(join(hidden, "shots", "after.png"), png());
  writeFileSync(join(hidden, "shots", ".cache", "frame.png"), png());
  // The same hidden parent, outside the worktree: not the folder sent from, and (as `~/.codex`) a
  // hidden folder of the home folder, so refused.
  mkdirSync(join(root, ".codex", "other"), { recursive: true });
  writeFileSync(join(root, ".codex", "other", "x.png"), png());
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const server = await start(dataDir);
    const sent = await send(await agent(server), {
      project_path: hidden,
      body: "![after](shots/after.png) ![frame](shots/.cache/frame.png) ![other](../../other/x.png)",
      agent_session: "ses_codex",
    });
    expect(sent.project.root).toBe(main);
    expect(server.store.message(sent.message_id)?.base_path).toBe(hidden);
    expect((await image(server, sent.message_id, "shots/after.png")).status).toBe(200);
    expect((await image(server, sent.message_id, "shots/.cache/frame.png")).status).toBe(200);
    const other = await image(server, sent.message_id, "../../other/x.png");
    expect(other.status).toBe(403);
    expect(((await other.json()) as { code: string }).code).toBe("image_hidden");
    expect(sent.images_not_shown).toEqual([{ ref: "../../other/x.png", reason: "a .env file, or in a hidden folder of the home folder such as ~/.ssh" }]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("relative attachments resolve in the worktree and are recorded by their realpath", async () => {
  const { worktree, dataDir } = world();
  const server = await start(dataDir);
  const sent = await send(await agent(server), {
    project_path: worktree,
    body: "The plan.",
    attachments: ["notes/plan.md"],
    agent_session: "ses_wt",
  });
  expect(sent.attachments).toHaveLength(1);
  expect(sent.attachments[0].path).toBe(join(worktree, "notes", "plan.md"));
  const view = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/attachments/${sent.attachments[0].id}/view`)).json()) as { text: string };
  expect(view.text).toBe("# Plan\n");
});

test("New message counts a session working in a worktree as a live session of the main repository's project", async () => {
  const { main, worktree, dataDir } = world();
  const server = await start(dataDir);
  const asked = await send(await agent(server), { project_path: main, body: "From the main checkout.", agent_session: "ses_main" });
  const poll = await fetch(`http://127.0.0.1:${server.port}${INBOX_BRIDGE_POLL_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ session: "ses_worktree_live", host: "claude-code", project_path: worktree, waitMs: 0 }),
  });
  expect(poll.status).toBe(200);
  const model = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${asked.thread_id}/sessions`)).json()) as { sessions: { session: string }[] };
  expect(model.sessions.map((s) => s.session)).toContain("ses_worktree_live");
});

test("a store from before the fold replays and routes as it did; only new sends from the worktree fold", async () => {
  const { main, worktree, dataDir } = world();
  const before = InboxStore.open(dataDir);
  const old = before.ensureProject({ name: "api-wt", root: worktree });
  const author = { kind: "agent" as const, host: "claude-code", session: "ses_wt", name: "Claude Code" };
  const thread = "Worktree notes";
  const first = before.sendMessage({ project_id: old.id, author, thread, body: "Written by an older Inbox." }).message;
  const second = before.sendMessage({ project_id: old.id, author, thread, body: "Same name, same thread." }).message;
  expect(second.thread_id).toBe(first.id);

  const server = await start(dataDir);
  const client = await agent(server);
  expect(server.store.project(old.id)?.root).toBe(worktree);
  expect(server.store.message(second.id)?.thread_id).toBe(first.id);
  const folded = await send(client, { project_path: worktree, thread, body: "Written after the fold.", agent_session: "ses_wt" });
  expect(folded.project.root).toBe(main);
  expect(folded.project.id).not.toBe(old.id);
  expect(folded.new_thread).toBe(true);
  const reply = await send(client, { project_path: worktree, reply_to: first.id, body: "A reply to the old thread.", agent_session: "ses_wt" });
  expect(reply.project.id).toBe(old.id);
  expect(reply.thread_id).toBe(first.id);
  const during = new Map(server.store.listRows().map((row) => [row.thread_id, row.project.id]));
  server.stop();
  servers.splice(servers.indexOf(server), 1);

  const after = InboxStore.open(dataDir);
  expect(new Map(after.listRows().map((row) => [row.thread_id, row.project.id]))).toEqual(during);
  for (const id of [first.id, second.id, reply.message_id, folded.message_id]) {
    expect(after.message(id)?.project_id).toBe(server.store.message(id)?.project_id);
    expect(after.message(id)?.thread_id).toBe(server.store.message(id)?.thread_id);
  }
  expect(after.sendMessage({ project_id: old.id, author, thread, body: "Old project, replayed." }).message.thread_id).toBe(first.id);
  expect(after.sendMessage({ project_id: folded.project.id, author, thread, body: "Main project, replayed." }).message.thread_id).toBe(folded.thread_id);
});

test("an agent that asked from a worktree before the fold still gets the reply: read_thread covers the worktree's earlier project", async () => {
  const { main, worktree, dataDir } = world();
  const before = InboxStore.open(dataDir);
  const old = before.ensureProject({ name: "api-wt", root: worktree });
  const author = { kind: "agent" as const, host: "codex", session: "ses_codex_wt", name: "Codex" };
  const asked = before.sendMessage({
    project_id: old.id,
    author,
    body: "Which store should the cache use?\n\n:::question\nWhich store should the cache use?\n- Postgres\n- Redis\n:::",
  }).message;
  before.sendReply(asked.id, { words: "Use Postgres.", idempotency_key: "reply-before-upgrade" });

  const server = await start(dataDir);
  const client = await agent(server);
  const listed = (await client.callTool({
    name: "read_thread",
    arguments: { project_path: worktree, agent_session: "ses_codex_wt", include_resolved: true },
  })) as { isError?: boolean; structuredContent: Record<string, any> };
  expect(listed.isError).toBeFalsy();
  expect(listed.structuredContent.threads.map((t: { thread_id: string }) => t.thread_id)).toContain(asked.id);
  const read = (await client.callTool({
    name: "read_thread",
    arguments: { thread_id: asked.id, project_path: worktree, agent_session: "ses_codex_wt" },
  })) as { isError?: boolean; structuredContent: Record<string, any> };
  expect(read.isError).toBeFalsy();
  expect(read.structuredContent.thread.messages.at(-1).body).toContain("Use Postgres.");

  const fromMain = (await client.callTool({
    name: "read_thread",
    arguments: { project_path: main, agent_session: "ses_codex_wt" },
  })) as { structuredContent: Record<string, any> };
  expect(fromMain.structuredContent.threads).toEqual([]);
});

test("when git does not answer in time, no project is made from a guess: the agent is told to try again, or the send lands in a project holding the folder", async () => {
  const { main, worktree, dataDir } = world();
  const real = inboxGitRunner();
  let slow = true;
  // git past its time limit, as the real runner reports it: no answer (the kill itself: inbox-project-root.test.ts).
  const git: InboxGitRunner = async (args, cwd) => {
    if (!slow) return real(args, cwd);
    await Bun.sleep(20);
    return null;
  };
  const server = await start(dataDir, git);
  const client = await agent(server);

  const refused = (await client.callTool({
    name: "send_message",
    arguments: { project_path: main, body: "Done with the migration.", agent_session: "ses_main", idempotency_key: "k1" },
  })) as { isError?: boolean; content: { text: string }[] };
  expect(refused.isError).toBe(true);
  expect(refused.content[0]!.text).toStartWith("project_unresolved:");
  expect(refused.content[0]!.text).toContain("try the same call again");
  expect(server.store.listProjects()).toEqual([]);
  expect(server.store.listRows()).toEqual([]);

  slow = false;
  const sent = await send(client, { project_path: main, body: "Done with the migration.", agent_session: "ses_main", idempotency_key: "k1" });
  expect(sent.project.root).toBe(main);

  slow = true;
  mkdirSync(join(main, "docs", "deep"), { recursive: true });
  const inside = await send(client, { project_path: join(main, "docs", "deep"), body: "From a subfolder.", agent_session: "ses_sub" });
  expect(inside.project.id).toBe(sent.project.id);
  const beside = (await client.callTool({
    name: "send_message",
    arguments: { project_path: worktree, body: "From the worktree.", agent_session: "ses_wt" },
  })) as { isError?: boolean; content: { text: string }[] };
  expect(beside.isError).toBe(true);
  expect(beside.content[0]!.text).toStartWith("project_unresolved:");
  expect(server.store.listProjects().map((p) => p.root)).toEqual([main]);
});

test("a folder project holding the worktree (a project at ~) never takes a guess: the send is refused, not filed there", async () => {
  const { root, worktree, dataDir } = world();
  const real = inboxGitRunner();
  let slow = false;
  const git: InboxGitRunner = async (args, cwd) => {
    if (!slow) return real(args, cwd);
    await Bun.sleep(20);
    return null;
  };
  const server = await start(dataDir, git);
  const client = await agent(server);
  const home = await send(client, { project_path: root, body: "Notes from the home folder.", agent_session: "ses_home" });
  expect(home.project.root).toBe(root);

  slow = true;
  const refused = (await client.callTool({
    name: "send_message",
    arguments: { project_path: worktree, body: "From the worktree.", agent_session: "ses_wt" },
  })) as { isError?: boolean; content: { text: string }[] };
  expect(refused.isError).toBe(true);
  expect(refused.content[0]!.text).toStartWith("project_unresolved:");
  expect(server.store.listRows({ projectId: home.project.id }).map((row) => row.thread_id)).toEqual([home.thread_id]);
  expect(server.store.listProjects().map((p) => p.root)).toEqual([root]);
});

test("read_thread's list from a worktree an older Inbox kept a project for lists that project's threads and makes no main-repository project", async () => {
  const { worktree, dataDir } = world();
  const before = InboxStore.open(dataDir);
  const old = before.ensureProject({ name: "api-wt", root: worktree });
  const author = { kind: "agent" as const, host: "codex", session: "ses_codex_wt", name: "Codex" };
  const asked = before.sendMessage({ project_id: old.id, author, body: "Asked before the fold." }).message;

  const server = await start(dataDir);
  const client = await agent(server);
  const listed = (await client.callTool({
    name: "read_thread",
    arguments: { project_path: worktree, agent_session: "ses_codex_wt" },
  })) as { isError?: boolean; structuredContent: Record<string, any> };
  expect(listed.isError).toBeFalsy();
  expect(listed.structuredContent.project.id).toBe(old.id);
  expect(listed.structuredContent.threads.map((t: { thread_id: string }) => t.thread_id)).toEqual([asked.id]);
  expect(server.store.listProjects().map((p) => p.root)).toEqual([worktree]);
});

test("read_thread's list when git does not answer in time: project_unresolved and nothing made; once git answers, the same call lists", async () => {
  const { main, dataDir } = world();
  const real = inboxGitRunner();
  let slow = true;
  const git: InboxGitRunner = async (args, cwd) => {
    if (!slow) return real(args, cwd);
    await Bun.sleep(20);
    return null;
  };
  const server = await start(dataDir, git);
  const client = await agent(server);
  const refused = (await client.callTool({
    name: "read_thread",
    arguments: { project_path: main, agent_session: "ses_main" },
  })) as { isError?: boolean; content: { text: string }[] };
  expect(refused.isError).toBe(true);
  expect(refused.content[0]!.text).toStartWith("project_unresolved:");
  expect(refused.content[0]!.text).toContain("try the same call again");
  expect(server.store.listProjects()).toEqual([]);

  slow = false;
  const listed = (await client.callTool({
    name: "read_thread",
    arguments: { project_path: main, agent_session: "ses_main" },
  })) as { isError?: boolean; structuredContent: Record<string, any> };
  expect(listed.isError).toBeFalsy();
  expect(listed.structuredContent.threads).toEqual([]);
  expect(server.store.listProjects()).toEqual([]);
});

test("a session started in a plain folder holding one repository's checkouts files into that repository's project, and still reads the folder's old threads", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-container-")));
  scratch.push(root);
  const folder = join(root, "workspaces", "projects", "appnotes");
  mkdirSync(join(folder, "worktrees"), { recursive: true });
  mkdirSync(join(folder, "shots"));
  writeFileSync(join(folder, "shots", "notes.png"), png());
  const main = join(folder, "worktrees", "main");
  git(root, "init", "-q", main);
  writeFileSync(join(main, "README.md"), "appnotes\n");
  git(main, "add", ".");
  git(main, "commit", "-qm", "init");
  const branch = join(folder, "worktrees", "agent-pr-plan-box");
  git(main, "worktree", "add", "-q", branch, "-b", "agent-pr-plan-box");
  const dataDir = join(root, "data");

  const before = InboxStore.open(dataDir);
  const old = before.ensureProject({ name: "appnotes", root: folder });
  const author = { kind: "agent" as const, host: "claude-code", session: "ses_folder", name: "Claude Code" };
  const asked = before.sendMessage({ project_id: old.id, author, body: "Ship the notes page?\n\n:::question\nShip the notes page?\n- Yes\n- No\n:::" }).message;
  before.sendReply(asked.id, { words: "Yes.", idempotency_key: "reply-folder" });

  const server = await start(dataDir);
  const client = await agent(server);
  const fromBranch = await send(client, { project_path: branch, body: "From a checkout.", agent_session: "ses_branch" });
  expect(fromBranch.project.root).toBe(main);
  expect(fromBranch.project.name).toBe("appnotes · main");
  const fromFolder = await send(client, { project_path: folder, body: "![notes](shots/notes.png)", agent_session: "ses_folder_new" });
  expect(fromFolder.project.id).toBe(fromBranch.project.id);
  expect(server.store.message(fromFolder.message_id)?.base_path).toBe(folder);
  expect((await image(server, fromFolder.message_id, "shots/notes.png")).status).toBe(200);
  expect(server.store.message(asked.id)?.project_id).toBe(old.id);
  const listed = (await client.callTool({ name: "read_thread", arguments: { project_path: folder, agent_session: "ses_folder", include_resolved: true } })) as {
    isError?: boolean;
    structuredContent: Record<string, any>;
  };
  expect(listed.isError).toBeFalsy();
  expect(listed.structuredContent.threads.map((t: { thread_id: string }) => t.thread_id)).toContain(asked.id);
  const reply = await send(client, { project_path: folder, reply_to: asked.id, body: "Shipped.", agent_session: "ses_folder" });
  expect(reply.project.id).toBe(old.id);
});

test("a fresh session in a checkouts folder whose checkout's git runs past the time limit still sends: it files into the repository read from disk", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-container-slow-")));
  scratch.push(root);
  const folder = join(root, "appnotes");
  mkdirSync(join(folder, "worktrees"), { recursive: true });
  const main = join(folder, "worktrees", "main");
  git(root, "init", "-q", main);
  writeFileSync(join(main, "README.md"), "appnotes\n");
  git(main, "add", ".");
  git(main, "commit", "-qm", "init");
  const real = inboxGitRunner();
  const slow: InboxGitRunner = async (args, cwd) => (cwd === main ? null : real(args, cwd));
  const server = await start(join(root, "data"), slow);
  const sent = await send(await agent(server), { project_path: folder, body: "From the folder, git slow.", agent_session: "ses_slow" });
  expect(sent.project.root).toBe(main);
  expect(sent.project.name).toBe("appnotes");
});
