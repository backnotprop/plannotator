/**
 * A message sent from a linked git worktree lands in its main repository's
 * project, while everything relative to the worktree keeps working: its
 * `base_path` names the worktree, so relative images and attachments resolve
 * where the agent works; New message counts a session working in the
 * worktree as one of the project's live sessions; and a store written before
 * the fold (a project keyed by the worktree) replays and routes exactly as it
 * did. A real Inbox on loopback under a temp data dir, real git repositories
 * and worktrees in temp folders, the official MCP client for the agent and
 * real `fetch` for the window and the connection.
 */
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

/** A PNG's signature and IHDR (2 x 3 px). */
function png(): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0]);
  return bytes;
}

/**
 * `api` (the main repository) and `api-wt`, a linked worktree BESIDE it,
 * outside its folder: the case where the worktree's files are not under the
 * project's root. Files only the worktree has: a screenshot and a plan.
 */
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
  // The agent's own folder is kept, though it lies outside the project's root.
  expect(server.store.message(fromWorktree.message_id)?.base_path).toBe(worktree);
  // A subfolder of the worktree is kept as it is.
  const deep = await send(client, { project_path: join(worktree, "notes"), body: "From notes.", agent_session: "ses_wt" });
  expect(deep.project.id).toBe(fromMain.project.id);
  expect(server.store.message(deep.message_id)?.base_path).toBe(join(worktree, "notes"));
  // The main checkout itself has no base.
  expect(server.store.message(fromMain.message_id)?.base_path).toBeUndefined();
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
  // An image in the main repository still serves (the project root).
  expect((await image(server, sent.message_id, join(main, "docs", "main-shot.png"))).status).toBe(200);
  // `../secret.png` from the worktree leaves both the worktree and the project, and still serves.
  expect((await image(server, sent.message_id, "../secret.png")).status).toBe(200);

  // Once the worktree is removed, its folder is no longer the message's: the image is just gone.
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
  // A hidden folder inside the folder sent from is the agent's own, as in its project.
  writeFileSync(join(hidden, "shots", ".cache", "frame.png"), png());
  // The same hidden parent, outside the worktree: not the folder sent from, and (as `~/.codex`) a
  // hidden folder of the home folder, so refused.
  mkdirSync(join(root, ".codex", "other"), { recursive: true });
  writeFileSync(join(root, ".codex", "other", "x.png"), png());
  // The temp root is a scratch home folder, as Codex keeps its worktrees in ~/.codex.
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
  // What an older Inbox wrote: a project keyed by the worktree, a thread in it.
  const before = InboxStore.open(dataDir);
  const old = before.ensureProject({ name: "api-wt", root: worktree });
  const author = { kind: "agent" as const, host: "claude-code", session: "ses_wt", name: "Claude Code" };
  const first = before.sendMessage({ project_id: old.id, author, body: "Written by an older Inbox." }).message;
  const second = before.sendMessage({ project_id: old.id, author, body: "Same session, same thread." }).message;
  expect(second.thread_id).toBe(first.id);

  const server = await start(dataDir);
  const client = await agent(server);
  // The old project and its thread are as they were.
  expect(server.store.project(old.id)?.root).toBe(worktree);
  expect(server.store.message(second.id)?.thread_id).toBe(first.id);
  // A new send from the worktree folds: the main repository's project, a new thread there.
  const folded = await send(client, { project_path: worktree, body: "Written after the fold.", agent_session: "ses_wt" });
  expect(folded.project.root).toBe(main);
  expect(folded.project.id).not.toBe(old.id);
  expect(folded.new_thread).toBe(true);
  // A reply into the old thread stays in the old project.
  const reply = await send(client, { project_path: worktree, reply_to: first.id, body: "A reply to the old thread.", agent_session: "ses_wt" });
  expect(reply.project.id).toBe(old.id);
  expect(reply.thread_id).toBe(first.id);
  const during = new Map(server.store.listRows().map((row) => [row.thread_id, row.project.id]));
  server.stop();
  servers.splice(servers.indexOf(server), 1);

  // Replayed from disk: every thread in the project it was in, and routing keyed by the recorded project.
  const after = InboxStore.open(dataDir);
  expect(new Map(after.listRows().map((row) => [row.thread_id, row.project.id]))).toEqual(during);
  for (const id of [first.id, second.id, reply.message_id, folded.message_id]) {
    expect(after.message(id)?.project_id).toBe(server.store.message(id)?.project_id);
    expect(after.message(id)?.thread_id).toBe(server.store.message(id)?.thread_id);
  }
  expect(after.sendMessage({ project_id: old.id, author, body: "Old project, replayed." }).message.thread_id).toBe(first.id);
  expect(after.sendMessage({ project_id: folded.project.id, author, body: "Main project, replayed." }).message.thread_id).toBe(folded.thread_id);
});

test("an agent that asked from a worktree before the fold still gets the reply: wait_for_reply and read_thread cover the worktree's earlier project", async () => {
  const { main, worktree, dataDir } = world();
  // An older Inbox: the question in a project keyed by the worktree, and the person's reply to it.
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
  // What the stdio shim sends: its working folder as project_path, and the session.
  const waited = (await client.callTool({
    name: "wait_for_reply",
    arguments: { project_path: worktree, agent_session: "ses_codex_wt", timeout_seconds: 1 },
  })) as { isError?: boolean; structuredContent: Record<string, any> };
  expect(waited.isError).toBeFalsy();
  expect(waited.structuredContent.status).toBe("replied");
  expect(waited.structuredContent.thread_id).toBe(asked.id);
  expect(waited.structuredContent.reply.body).toContain("Use Postgres.");

  const listed = (await client.callTool({
    name: "read_thread",
    arguments: { project_path: worktree, agent_session: "ses_codex_wt", include_resolved: true },
  })) as { isError?: boolean; structuredContent: Record<string, any> };
  expect(listed.isError).toBeFalsy();
  expect(listed.structuredContent.project.root).toBe(main);
  expect(listed.structuredContent.threads.map((t: { thread_id: string }) => t.thread_id)).toContain(asked.id);

  // From the main checkout, the worktree's earlier project is not in the read: the scope is that worktree's alone.
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

  // git answers again: the same call lands, in the main repository's project.
  slow = false;
  const sent = await send(client, { project_path: main, body: "Done with the migration.", agent_session: "ses_main", idempotency_key: "k1" });
  expect(sent.project.root).toBe(main);

  // git slow again: a folder inside the known project lands there; the worktree beside it has no project to land in.
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
  // `root` plays ~: no repository, and both `api` and its worktree `api-wt` live under it.
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

  // A new worktree, and git past its time limit: ~ holds the folder but is no repository.
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
  // A read is not a write: the main repository has no project until something is sent from it.
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
