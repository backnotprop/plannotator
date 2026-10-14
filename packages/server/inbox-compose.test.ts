/**
 * Compose ("send a new message to a connected agent"), through the server's
 * real doors: the live sessions in every project, a new thread the person
 * starts, its delivery to that session alone with the new-thread wake line,
 * the agent's answer in the same thread, Send to another session, drafts
 * (kept out of the event log and search) and uploads that become ordinary
 * attachments. Every test uses its own temp data dir; the connections are
 * plain HTTP calls with the registry's token, never a real agent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxComposeProject, InboxDraft, InboxListRow, InboxMessage, InboxThread, InboxUpload } from "@plannotator/core/inbox-types";
import {
  INBOX_BRIDGE_EVENT_PATH,
  INBOX_BRIDGE_POLL_PATH,
  INBOX_MESSAGE_INSTRUCTION,
  INBOX_NEW_THREAD_INSTRUCTION,
  inboxWakeText,
  parseInboxBridgeCommands,
} from "@plannotator/shared/inbox/connection";
import { inboxId } from "@plannotator/core/inbox-types";
import { INBOX_WAKE_INSTRUCTION, inboxContinuesLine } from "@plannotator/shared/inbox/connection";
import { InboxAgentConnection, InboxWake } from "@plannotator/shared/inbox/agent-link";
import { startInboxServer, type InboxServer } from "./inbox";
import type { InboxGitRunner } from "./inbox-project-root";

/** git with no user or system config, for the worktree tests' own repositories. */
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

/** The Inbox's git (rev-parse) for these tests: no user or system config, and no env mutation. */
const quietGit = (): InboxGitRunner => async (args, cwd) => {
  const env: Record<string, string | undefined> = { ...GIT_ENV };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[key];
  const proc = Bun.spawn(["git", ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { exitCode, stdout };
};

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup(projectRootGit?: InboxGitRunner) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-compose-")));
  roots.push(root);
  const ledger = join(root, "ledger");
  const billing = join(root, "billing");
  mkdirSync(ledger, { recursive: true });
  mkdirSync(billing, { recursive: true });
  const dataDir = join(root, "data");
  const server = await startInboxServer({ dataDir, ...(projectRootGit ? { projectRootGit } : {}) });
  servers.push(server);
  const client = new Client({ name: "inbox-compose-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client, ledger, billing, dataDir };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;

function bridge(server: InboxServer, path: string, body: unknown): Promise<Response> {
  return fetch(`${base(server)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify(body),
  });
}

/** One poll from a connection: the session is live for 30 s after it. */
async function poll(server: InboxServer, session: string, host: string, project?: string) {
  const response = await bridge(server, INBOX_BRIDGE_POLL_PATH, { session, host, waitMs: 0, ...(project ? { project_path: project, started_at: Date.now(), busy: false } : {}) });
  expect(response.status).toBe(200);
  return parseInboxBridgeCommands(await response.text());
}

function post(server: InboxServer, path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return fetch(`${base(server)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ serverSession: server.serverSession, ...body }),
  });
}

async function sessions(server: InboxServer, query = ""): Promise<{ projects: InboxComposeProject[]; session?: { session: string; live: boolean } }> {
  return (await (await fetch(`${base(server)}/api/inbox/sessions${query}`)).json()) as never;
}

async function thread(server: InboxServer, threadId: string): Promise<InboxThread & { row?: InboxListRow }> {
  const body = (await (await fetch(`${base(server)}/api/inbox/threads/${threadId}`)).json()) as { thread: InboxThread; row: InboxListRow };
  return { ...body.thread, row: body.row };
}

async function upload(server: InboxServer, name: string, bytes: Uint8Array | string): Promise<Response> {
  return fetch(`${base(server)}/api/inbox/uploads?name=${encodeURIComponent(name)}&serverSession=${server.serverSession}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
  });
}

const PNG = Uint8Array.from(Buffer.from("89504e470d0a1a0a0000000d49484452000000020000000308060000009d74c6e10000000d49444154789c636060000000040001f61738550000000049454e44ae426082", "hex"));

describe("the live sessions in every project", () => {
  test("are grouped by the project each works in; a session without a folder is placed where it wrote; one with neither is not listed", async () => {
    const { server, client, ledger, billing } = await setup();
    await poll(server, "ses-claude", "claude-code", ledger);
    await poll(server, "ses-pi", "pi", billing);
    // An MCP-only writer whose connection polls without a folder: placed in the project it wrote in.
    await client.callTool({ name: "send_message", arguments: { body: "Relay done.", project_path: ledger, agent_session: "ses-oc", agent_host: "opencode" } });
    await poll(server, "ses-oc", "opencode");
    await poll(server, "ses-nowhere", "opencode");

    const model = await sessions(server, "?session=ses-claude");
    expect(model.session).toEqual({ session: "ses-claude", live: true });
    const byRoot = new Map(model.projects.map((group) => [group.project.root, group]));
    expect([...byRoot.keys()].sort()).toEqual([billing, ledger].sort());
    // billing is new to the Inbox: no id yet, named by its folder.
    expect(byRoot.get(billing)!.project).toEqual({ id: null, name: "billing", root: billing });
    expect(byRoot.get(ledger)!.project.id).toMatch(/^prj_/);
    expect(byRoot.get(ledger)!.sessions.map((s) => s.session).sort()).toEqual(["ses-claude", "ses-oc"]);
    const oc = byRoot.get(ledger)!.sessions.find((s) => s.session === "ses-oc")!;
    expect(oc.last_thread).toMatchObject({ subject: "Relay done." });
    expect(byRoot.get(billing)!.sessions[0]).toMatchObject({ session: "ses-pi", host: "pi", busy: false, last_thread: null });
  });
});

describe("a thread the person starts", () => {
  test("goes to the chosen session only, as a new-thread wake; its delivery and the agent's answer follow in the same thread", async () => {
    const { server, client, billing } = await setup();
    await poll(server, "ses-pi", "pi", billing);
    await poll(server, "ses-other", "claude-code", billing);

    const response = await post(server, "/api/inbox/messages", { to: { host: "pi", session: "ses-pi" }, body: "Idea: retry the webhook on a 409.\n\nIt is safe with the same key.", idempotency_key: "c1" });
    expect(response.status).toBe(200);
    const sent = (await response.json()) as { thread_id: string; message: InboxMessage; project: { id: string; root: string } };
    expect(sent.project.root).toBe(billing);
    expect(sent.message).toMatchObject({ started_by_person: true, to: { host: "pi", session: "ses-pi" }, subject: "Idea: retry the webhook on a 409." });

    let opened = await thread(server, sent.thread_id);
    expect(opened.row).toMatchObject({ section: "sent", addressee: { host: "pi", session: "ses-pi" } });

    expect(await poll(server, "ses-other", "claude-code", billing)).toEqual([]);
    const commands = await poll(server, "ses-pi", "pi", billing);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: "message", id: sent.message.id, reply_to: null, new_thread: true });
    const lines = inboxWakeText(commands[0]!).split("\n");
    expect(lines[0]).toBe(`Plannotator Inbox: Idea: retry the webhook on a 409. (${sent.message.id})`);
    expect(lines[1]).toBe(INBOX_NEW_THREAD_INSTRUCTION);
    // An older connection that ignores new_thread still words it as a New message, which stays true.
    const { new_thread: _ignored, ...older } = commands[0]!;
    expect(inboxWakeText(older).split("\n")[1]).toBe(INBOX_MESSAGE_INSTRUCTION);

    expect((await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-other", host: "claude-code", type: "delivered", id: sent.message.id })).status).toBe(422);
    expect((await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-pi", host: "pi", type: "delivered", id: sent.message.id })).status).toBe(200);
    opened = await thread(server, sent.thread_id);
    expect(opened.messages[0]!.delivery).toMatchObject({ session: "ses-pi" });
    expect(opened.row!.section).toBe("quiet");

    await client.callTool({
      name: "send_message",
      arguments: { body: "I'll add it after the current fix.", reply_to: sent.message.id, project_path: billing, agent_session: "ses-pi", agent_host: "pi" },
    });
    opened = await thread(server, sent.thread_id);
    expect(opened.messages.map((m) => m.author.kind)).toEqual(["person", "agent"]);
    expect(opened.row!.section).toBe("new");
  });

  test("nothing is sent without a live session; a replay answers what it wrote; a stale tab and another site are refused", async () => {
    const { server, billing } = await setup();
    const cursor = () => server.store.cursor();
    const before = cursor();
    const refused = await post(server, "/api/inbox/messages", { to: { session: "ses-gone" }, body: "Hello", idempotency_key: "c0" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("session_not_live");
    expect(cursor()).toBe(before);

    await poll(server, "ses-pi", "pi", billing);
    const first = (await (await post(server, "/api/inbox/messages", { to: { session: "ses-pi" }, body: "Hello", idempotency_key: "c1" })).json()) as { message: InboxMessage };
    const after = cursor();
    const again = await post(server, "/api/inbox/messages", { to: { session: "ses-gone" }, body: "Hello", idempotency_key: "c1" });
    expect(((await again.json()) as { replayed: boolean; message: InboxMessage })).toMatchObject({ replayed: true, message: { id: first.message.id } });
    expect(cursor()).toBe(after);

    const stale = await post(server, "/api/inbox/messages", { to: { session: "ses-pi" }, body: "x", idempotency_key: "c2", serverSession: "someone-else" });
    expect(stale.status).toBe(409);
    const foreign = await post(server, "/api/inbox/messages", { to: { session: "ses-pi" }, body: "x", idempotency_key: "c3" }, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" });
    expect(foreign.status).toBe(403);
    expect(cursor()).toBe(after);
  });

  test("Send to another session moves a message no session took yet; once delivered it stays", async () => {
    const { server, billing } = await setup();
    await poll(server, "ses-a", "claude-code", billing);
    const sent = (await (await post(server, "/api/inbox/messages", { to: { session: "ses-a" }, body: "Rename Quiet?", idempotency_key: "c1" })).json()) as { message: InboxMessage };
    await poll(server, "ses-b", "pi", billing);
    const moved = await post(server, `/api/inbox/messages/${sent.message.id}/to`, { to: { host: "pi", session: "ses-b" } });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as { row: InboxListRow }).row.addressee).toEqual({ host: "pi", session: "ses-b" });
    expect(await poll(server, "ses-a", "claude-code", billing)).toEqual([]);
    expect((await poll(server, "ses-b", "pi", billing)).map((c) => c.id)).toEqual([sent.message.id]);

    const gone = await post(server, `/api/inbox/messages/${sent.message.id}/to`, { to: { session: "ses-gone" } });
    expect(((await gone.json()) as { code: string }).code).toBe("session_not_live");
    await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-b", host: "pi", type: "delivered", id: sent.message.id });
    const late = await post(server, `/api/inbox/messages/${sent.message.id}/to`, { to: { session: "ses-a" } });
    expect(late.status).toBe(409);
    expect(((await late.json()) as { code: string }).code).toBe("already_delivered");
  });

  test("more words before the agent answered reach only its session: another agent's read_thread or wait_for_reply settles nothing", async () => {
    const { server, client, billing } = await setup();
    await poll(server, "ses-a", "claude-code", billing);
    const sent = (await (await post(server, "/api/inbox/messages", { to: { session: "ses-a" }, body: "Add a retry budget.", idempotency_key: "c1" })).json()) as { message: InboxMessage };
    const more = await post(server, `/api/inbox/messages/${sent.message.id}/reply`, { words: "And log each retry.", idempotency_key: "r1" });
    expect(more.status).toBe(200);
    const follow = ((await more.json()) as { reply: InboxMessage }).reply;
    expect(follow.to).toMatchObject({ session: "ses-a" });

    // An unrelated agent reads the thread and waits on it.
    await client.callTool({ name: "read_thread", arguments: { thread_id: sent.message.thread_id, agent_session: "ses-x" } });
    const waited = (await client.callTool({ name: "wait_for_reply", arguments: { thread_id: sent.message.thread_id, agent_session: "ses-x", timeout_seconds: 1 } })) as {
      structuredContent: { status: string };
    };
    expect(waited.structuredContent.status).toBe("waiting");

    expect((await poll(server, "ses-a", "claude-code", billing)).map((c) => c.id)).toEqual([sent.message.id, follow.id]);
    // Its own wait_for_reply gets the words (and settles them).
    const mine = (await client.callTool({ name: "wait_for_reply", arguments: { thread_id: sent.message.thread_id, agent_session: "ses-a", timeout_seconds: 1 } })) as {
      structuredContent: { status: string; reply: { message_id: string } };
    };
    expect(mine.structuredContent).toMatchObject({ status: "replied" });
  });

  test("more words moved to a session that has seen nothing of the thread wake it with the line to read the thread first", async () => {
    const { server, billing } = await setup();
    await poll(server, "ses-a", "claude-code", billing);
    const sent = (await (await post(server, "/api/inbox/messages", { to: { session: "ses-a" }, body: "Add a retry budget.", idempotency_key: "c1" })).json()) as { message: InboxMessage };
    await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-a", host: "claude-code", type: "delivered", id: sent.message.id });
    const follow = ((await (await post(server, `/api/inbox/messages/${sent.message.id}/reply`, { words: "And log each retry.", idempotency_key: "r1" })).json()) as { reply: InboxMessage }).reply;
    // ses-a took the thread: its follow-up wakes it as a plain reply.
    const [own] = await poll(server, "ses-a", "claude-code", billing);
    expect(own).toMatchObject({ type: "reply", id: follow.id });
    expect(own!.continues_thread).toBeUndefined();

    await poll(server, "ses-b", "pi", billing);
    expect((await post(server, `/api/inbox/messages/${follow.id}/to`, { to: { host: "pi", session: "ses-b" } })).status).toBe(200);
    const [moved] = await poll(server, "ses-b", "pi", billing);
    expect(moved).toMatchObject({ id: follow.id, continues_thread: true });
    const lines = inboxWakeText(moved!).split("\n");
    expect(lines[1]).toBe(INBOX_WAKE_INSTRUCTION);
    expect(lines[2]).toBe(inboxContinuesLine(follow.id));

    // An archived thread is not re-addressed.
    expect((await post(server, `/api/inbox/messages/${sent.message.id}/resolve`, { resolved: true })).status).toBe(200);
    const archived = await post(server, `/api/inbox/messages/${follow.id}/to`, { to: { host: "claude-code", session: "ses-a" } });
    expect(((await archived.json()) as { code: string }).code).toBe("thread_resolved");
  });

  test("two Sends racing with one key write one message, one answers replayed, and no copied file is left behind", async () => {
    const { server, billing, dataDir } = await setup();
    await poll(server, "ses-pi", "pi", billing);
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) ids.push(((await (await upload(server, "notes.md", "# Notes")).json()) as { upload: InboxUpload }).upload.upload_id);
    const answers = (await Promise.all(
      ids.map(async (id) => (await post(server, "/api/inbox/messages", { to: { session: "ses-pi" }, body: "See notes.", idempotency_key: "same", uploads: [id] })).json()),
    )) as { replayed: boolean; message: InboxMessage }[];
    expect(answers.map((a) => a.replayed).sort()).toEqual([false, true]);
    expect(new Set(answers.map((a) => a.message.id)).size).toBe(1);
    const kept = answers[0]!.message.attachments!.map((a) => a.id);
    const onDisk = readdirSync(join(dataDir, "inbox", "uploads")).filter((name) => name.startsWith("att_"));
    expect(onDisk).toEqual(kept);
  });
});

describe("worktrees and a slow git (#1919)", () => {
  test("a session working in a linked worktree is listed under, and its thread lands in, the main repository's project", async () => {
    const { server, ledger } = await setup(quietGit());
    const repo = join(ledger, "api");
    mkdirSync(repo, { recursive: true });
    git(ledger, "init", "-q", repo);
    writeFileSync(join(repo, "README.md"), "api\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "init");
    const worktree = join(ledger, "api-wt");
    git(repo, "worktree", "add", "-q", worktree, "-b", "feature");

    await poll(server, "ses-wt", "claude-code", worktree);
    const listed = await sessions(server);
    expect(listed.projects.map((p) => [p.project.root, p.sessions.map((s) => s.session)])).toEqual([[repo, ["ses-wt"]]]);
    const response = await post(server, "/api/inbox/messages", { to: { session: "ses-wt" }, body: "Try the retry budget here.", idempotency_key: "c1" });
    expect(response.status).toBe(200);
    const sent = (await response.json()) as { project: { root: string } };
    expect(sent.project.root).toBe(repo);
    expect(server.store.listProjects().map((p) => p.root)).toEqual([repo]);
  });

  test("git too slow to tell the project: the Send is refused with project_unresolved and a message to try again; nothing is written", async () => {
    const real = quietGit();
    let slow = false;
    const runner: InboxGitRunner = async (args, cwd) => {
      if (!slow) return real(args, cwd);
      await Bun.sleep(20);
      return null;
    };
    const { server, billing, dataDir } = await setup(runner);
    slow = true;
    await poll(server, "ses-pi", "pi", billing);
    const file = ((await (await upload(server, "notes.md", "# Notes")).json()) as { upload: InboxUpload }).upload;
    const before = server.store.cursor();
    const refused = await post(server, "/api/inbox/messages", { to: { session: "ses-pi" }, body: "Hello", idempotency_key: "c1", uploads: [file.upload_id] });
    expect(refused.status).toBe(503);
    const body = (await refused.json()) as { code: string; error: string };
    expect(body.code).toBe("project_unresolved");
    expect(body.error).toContain("try the same call again");
    expect(server.store.cursor()).toBe(before);
    expect(server.store.listProjects()).toEqual([]);
    // The upload is still pending, so the same Send can go once git answers.
    expect(existsSync(join(dataDir, "inbox", "uploads", "pending", `${file.upload_id}.json`))).toBe(true);
    slow = false;
    const again = await post(server, "/api/inbox/messages", { to: { session: "ses-pi" }, body: "Hello", idempotency_key: "c1", uploads: [file.upload_id] });
    expect(again.status).toBe(200);
  });
});

describe("uploads", () => {
  test("become ordinary attachments: a real read-only file with its name, viewable, listed unchanged, named in the wake", async () => {
    const { server, billing, dataDir } = await setup();
    const text = await upload(server, "notes.md", "# Notes\n\nThe export.");
    expect(text.status).toBe(200);
    const notes = ((await text.json()) as { upload: InboxUpload }).upload;
    expect(notes).toMatchObject({ name: "notes.md", kind: "markdown", size: 20 });
    const image = ((await (await upload(server, "shot.png", PNG)).json()) as { upload: InboxUpload }).upload;
    expect(image).toMatchObject({ kind: "image", media_type: "image/png", width: 2, height: 3 });

    await poll(server, "ses-pi", "pi", billing);
    const sent = (await (await post(server, "/api/inbox/messages", { to: { session: "ses-pi" }, body: "See the files.", idempotency_key: "c1", uploads: [notes.upload_id, image.upload_id] })).json()) as {
      message: InboxMessage;
    };
    const attachments = sent.message.attachments!;
    expect(attachments.map((a) => [a.name, a.kind])).toEqual([["notes.md", "markdown"], ["shot.png", "image"]]);
    for (const attachment of attachments) {
      expect(attachment.path.startsWith(realpathSync(join(dataDir, "inbox", "uploads")))).toBe(true);
      expect(statSync(attachment.path).mode & 0o222).toBe(0);
    }
    expect(readFileSync(attachments[0]!.path, "utf8")).toBe("# Notes\n\nThe export.");
    // A copy, not a link: an agent that writes to its file does not change the version sent.
    chmodSync(attachments[0]!.path, 0o600);
    writeFileSync(attachments[0]!.path, "changed by the agent");
    expect(readFileSync(join(dataDir, "inbox", "blobs", attachments[0]!.sent_sha256), "utf8")).toBe("# Notes\n\nThe export.");
    writeFileSync(attachments[0]!.path, "# Notes\n\nThe export.");
    // The pending records are gone; the blobs stay with the message.
    expect(existsSync(join(dataDir, "inbox", "uploads", "pending", `${notes.upload_id}.json`))).toBe(false);

    const view = (await (await fetch(`${base(server)}/api/inbox/attachments/${attachments[0]!.id}/view`)).json()) as { text: string };
    expect(view.text).toBe("# Notes\n\nThe export.");
    const listed = (await (await fetch(`${base(server)}/api/inbox/threads/${sent.message.thread_id}/attachments`)).json()) as { attachments: { changed_since_sent: boolean }[] };
    expect(listed.attachments.map((a) => a.changed_since_sent)).toEqual([false, false]);

    const [command] = await poll(server, "ses-pi", "pi", billing);
    expect(command!.body).toBe(`See the files.\n\nAttached: notes.md (${attachments[0]!.path})\nAttached: shot.png (${attachments[1]!.path})`);
  });

  test("the dotenv family, path separators and control characters are refused, and nothing is kept", async () => {
    const { server, dataDir } = await setup();
    for (const name of [".env", "prod.env", ".env.local", "a/b.txt", "..", "x\ny.txt", "x\u0085y.txt", "x\u2028y.txt", "evil\u202egnp.txt"]) {
      const response = await upload(server, name, "SECRET=1");
      expect(response.status).toBe(422);
      expect(((await response.json()) as { code: string }).code).toBe("upload_refused");
    }
    expect(((await (await upload(server, ".env", "SECRET=1")).json()) as { error: string }).error).toBe("Not attached: .env files often hold secrets.");
    expect(existsSync(join(dataDir, "inbox", "uploads", "pending"))).toBe(false);
    const stale = await fetch(`${base(server)}/api/inbox/uploads?name=a.txt&serverSession=other`, { method: "POST", body: "x" });
    expect(stale.status).toBe(409);
  });
});

describe("drafts", () => {
  test("save with compare-and-set, list with their chip, delete; sending from one deletes it", async () => {
    const { server, billing } = await setup();
    const id = inboxId("drf");
    const notes = ((await (await upload(server, "notes.md", "draft notes")).json()) as { upload: InboxUpload }).upload;
    const created = await post(server, `/api/inbox/drafts/${id}`, { body: "Rename Quiet to Done?", to: null, project: { id: null, root: billing, name: "billing" }, files: [notes.upload_id], base: null });
    expect(created.status).toBe(200);
    const draft = ((await created.json()) as { draft: InboxDraft & { status: string } }).draft;
    expect(draft).toMatchObject({ id, body: "Rename Quiet to Done?", status: "none", files: [{ upload_id: notes.upload_id, name: "notes.md" }] });

    // A second create, or a save from a stale read, is refused with the newer draft.
    const conflict = await post(server, `/api/inbox/drafts/${id}`, { body: "other tab", base: null });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { code: string; draft: InboxDraft }).draft.body).toBe("Rename Quiet to Done?");

    await poll(server, "ses-pi", "pi", billing);
    const addressed = await post(server, `/api/inbox/drafts/${id}`, {
      body: "Rename Quiet to Done?",
      to: { host: "pi", session: "ses-pi", project_root: billing, project_name: "billing", started_at: null },
      files: [notes.upload_id],
      base: draft.updated_at,
    });
    const saved = ((await addressed.json()) as { draft: InboxDraft & { status: string } }).draft;
    expect(saved.status).toBe("live");
    const ended = inboxId("drf");
    await post(server, `/api/inbox/drafts/${ended}`, { body: "For a session that is gone", to: { host: "claude-code", session: "ses-gone" }, base: null });
    const list = ((await (await fetch(`${base(server)}/api/inbox/drafts`)).json()) as { drafts: (InboxDraft & { status: string })[] }).drafts;
    expect(new Map(list.map((d) => [d.id, d.status]))).toEqual(new Map([[id, "live"], [ended, "ended"]]));

    // Drafts never enter the event log (agents, phones, search read it).
    expect(JSON.stringify(server.store.changesSince(0))).not.toContain("Rename Quiet");

    const sent = await post(server, "/api/inbox/messages", { to: { session: "ses-pi" }, body: saved.body, idempotency_key: "c1", uploads: [notes.upload_id], draft_id: id });
    expect(sent.status).toBe(200);
    const after = ((await (await fetch(`${base(server)}/api/inbox/drafts`)).json()) as { drafts: InboxDraft[] }).drafts;
    expect(after.map((d) => d.id)).toEqual([ended]);
    expect(((await (await post(server, `/api/inbox/drafts/${ended}/delete`, {})).json()) as { deleted: boolean }).deleted).toBe(true);
    expect(((await (await fetch(`${base(server)}/api/inbox/drafts`)).json()) as { drafts: InboxDraft[] }).drafts).toEqual([]);
  });

  test("a draft naming an upload that is gone is refused", async () => {
    const { server } = await setup();
    const response = await post(server, `/api/inbox/drafts/${inboxId("drf")}`, { body: "x", files: [inboxId("upl")], base: null });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("upload_not_found");
  });
});

describe("the Pi and OpenCode wake (agent-link)", () => {
  test("its poll says where the session works and whether a turn runs, so it is listed before it ever wrote; a thread started for it arrives with the new-thread line", async () => {
    const { server, billing, dataDir } = await setup();
    const connection = new InboxAgentConnection({ dataDir, host: "pi", agentName: "Pi", tools: [] });
    let busy = false;
    const delivered: { text: string; id: string }[] = [];
    const wake = new InboxWake(
      connection,
      "ses-pi",
      { isBusy: () => busy, deliver: async (text, command) => void delivered.push({ text, id: command.id }), notify: () => {}, projectPath: () => billing },
      50,
    );
    wake.start();
    try {
      const listed = async () => (await sessions(server)).projects.find((group) => group.project.root === billing)?.sessions.find((s) => s.session === "ses-pi");
      let entry = await listed();
      for (let i = 0; i < 100 && entry?.busy !== false; i++) {
        await Bun.sleep(50);
        entry = await listed();
      }
      expect(entry).toMatchObject({ host: "pi", busy: false, last_thread: null });
      expect(Date.parse(entry!.started_at)).toBeGreaterThan(0);

      // A turn starts: the next state check posts a `state` event.
      busy = true;
      for (let i = 0; i < 100 && entry?.busy !== true; i++) {
        await Bun.sleep(50);
        entry = await listed();
      }
      expect(entry!.busy).toBe(true);
      busy = false;

      const sent = (await (await post(server, "/api/inbox/messages", { to: { host: "pi", session: "ses-pi" }, body: "Add a retry budget.", idempotency_key: "c1" })).json()) as { message: InboxMessage };
      for (let i = 0; i < 200 && delivered.length === 0; i++) await Bun.sleep(50);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]!.id).toBe(sent.message.id);
      expect(delivered[0]!.text.split("\n")[1]).toBe(INBOX_NEW_THREAD_INSTRUCTION);
      let delivery: unknown = null;
      for (let i = 0; i < 100 && !delivery; i++) {
        delivery = (await thread(server, sent.message.thread_id)).messages[0]!.delivery ?? null;
        if (!delivery) await Bun.sleep(50);
      }
      expect(delivery).toMatchObject({ host: "pi", session: "ses-pi" });
    } finally {
      wake.dispose();
    }
  });
});
