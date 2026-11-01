/**
 * Combining projects through the Inbox's real doors: `POST
 * /api/inbox/projects/:id/combine` on a running Inbox (temp data dir, loopback),
 * real git repositories in temp folders and the official MCP client for the
 * agents. What can regress: an agent in the combined folder losing sight of the
 * other folder's threads, search or cards, Compose splitting one project in
 * two, a session in the other folder not being offered, Tidy suggesting a
 * guess, the delete rule losing a project, and the route skipping a guard the
 * other window writes have.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxComposeProject, InboxListSection, InboxProject, InboxTidyPlan } from "@plannotator/core/inbox-types";
import { INBOX_BRIDGE_POLL_PATH } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";

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

/** A repository with a commit, at `folder`, with `origin` when one is given. */
function repository(folder: string, origin?: string): string {
  mkdirSync(folder, { recursive: true });
  git(folder, "init", "-q");
  git(folder, "commit", "-q", "--allow-empty", "-m", "init");
  if (origin) git(folder, "remote", "add", "origin", origin);
  return folder;
}

const ORIGIN = "https://github.com/acme/ledger.git";

/** The person's layout: one repository cloned twice, and an unrelated project. */
async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-combine-")));
  scratch.push(root);
  const ledger = repository(join(root, "code", "ledger"), ORIGIN);
  const clone = repository(join(root, "scratch", "ledger-2"), ORIGIN);
  const other = repository(join(root, "code", "billing"), "https://github.com/acme/billing.git");
  const server = await startInboxServer({ dataDir: join(root, "data"), phones: false, board: true });
  servers.push(server);
  const client = new Client({ name: "inbox-project-combine-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { root, ledger, clone, other, server, client };
}

type ToolResult = { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };

async function tool(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  if (result.isError) throw new Error(result.content[0]!.text);
  return result.structuredContent;
}

const send = (client: Client, args: Record<string, unknown>) => tool(client, "send_message", args);

const url = (server: InboxServer, path: string) => `http://127.0.0.1:${server.port}${path}`;
const post = (server: InboxServer, path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(url(server, path), { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) });
const combine = (server: InboxServer, id: string, into: string | null) => post(server, `/api/inbox/projects/${id}/combine`, { into });

/** A connection polling from `folder`: the session is live for 30 s after it. */
async function poll(server: InboxServer, session: string, folder: string): Promise<void> {
  const response = await fetch(url(server, INBOX_BRIDGE_POLL_PATH), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ session, host: "claude-code", waitMs: 0, project_path: folder, started_at: Date.now(), busy: false }),
  });
  expect(response.status).toBe(200);
}

const rows = async (server: InboxServer) => {
  const model = (await (await fetch(url(server, "/api/inbox/threads"))).json()) as { sections: InboxListSection[] };
  return model.sections.flatMap((section) => section.threads);
};

const composeProjects = async (server: InboxServer) => ((await (await fetch(url(server, "/api/inbox/sessions"))).json()) as { projects: InboxComposeProject[] }).projects;
const tidyPlan = async (server: InboxServer) => (await (await fetch(url(server, "/api/inbox/tidy?surface=list"))).json()) as InboxTidyPlan;
const folders = async (server: InboxServer) => ((await (await fetch(url(server, "/api/inbox/projects"))).json()) as { projects: { id: string; name: string; combined?: { id: string; name: string }[] }[] }).projects;

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (done(value)) return value;
    await Bun.sleep(20);
  }
  throw new Error("the Inbox did not reach the expected state");
}

/** Both clones, each with one thread, combined: `from` into `into`. */
async function combined() {
  const w = await world();
  const inLedger = await send(w.client, { project_path: w.ledger, subject: "Ledger migration", body: "Heron carried the ledger.", agent_session: "ses_ledger" });
  const inClone = await send(w.client, { project_path: w.clone, subject: "Clone cleanup", body: "Marlin carried the clone.", agent_session: "ses_clone" });
  const into = inLedger.project.id as string;
  const from = inClone.project.id as string;
  expect(from).not.toBe(into);
  expect((await combine(w.server, from, into)).status).toBe(200);
  return { ...w, inLedger, inClone, into, from };
}

describe("POST /api/inbox/projects/:id/combine", () => {
  test("answers the project the rows now show, and null undoes it", async () => {
    const w = await combined();
    expect(w.server.store.project(w.from)?.merged_into).toBe(w.into);
    expect((await rows(w.server)).map((row) => row.project.id)).toEqual([w.into, w.into]);
    expect((await folders(w.server)).map((folder) => folder.id).sort()).toEqual([w.into].sort());

    const undone = await combine(w.server, w.from, null);
    expect(undone.status).toBe(200);
    expect((await rows(w.server)).map((row) => row.project.id).sort()).toEqual([w.into, w.from].sort());
    expect(w.server.store.project(w.from)).toMatchObject({ separated_from: w.into });
    expect(w.server.store.project(w.from)?.merged_into).toBeUndefined();
  });

  test("refuses itself, a member of itself, a missing project, a bad id, and requests without the window's guards", async () => {
    const w = await combined();
    const path = `/api/inbox/projects/${w.into}/combine`;
    // The head into its own member: that would be a loop.
    const loop = await combine(w.server, w.into, w.from);
    expect(loop.status).toBe(422);
    expect(((await loop.json()) as { code: string }).code).toBe("validation_error");
    expect((await combine(w.server, w.into, w.into)).status).toBe(422);
    expect((await combine(w.server, "prj_00000000000000000000000000", w.into)).status).toBe(404);
    expect((await combine(w.server, w.into, "prj_00000000000000000000000000")).status).toBe(404);
    expect((await combine(w.server, "nope", w.into)).status).toBe(422);
    for (const body of [{}, { into: 42 }, { into: "nope" }]) expect((await post(w.server, path, body)).status).toBe(422);
    // Another site's page, a tab of an older Inbox, a GET.
    const third = (await send(w.client, { project_path: w.other, body: "Billing.", agent_session: "ses_other" })).project.id as string;
    const thirdPath = `/api/inbox/projects/${third}/combine`;
    const cross = await post(w.server, thirdPath, { into: w.into }, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" });
    expect(cross.status).toBe(403);
    expect(((await cross.json()) as { code: string }).code).toBe("cross_origin");
    expect((await post(w.server, thirdPath, { into: w.into, serverSession: "an-older-inbox" })).status).toBe(409);
    expect((await fetch(url(w.server, thirdPath))).status).toBe(405);
    // Nothing above changed anything.
    expect(w.server.store.project(third)?.merged_into).toBeUndefined();
    expect(w.server.store.project(w.into)?.merged_into).toBeUndefined();
  });
});

describe("an id from before the combine", () => {
  test("the list, the archive and the project menu's batches answer for the project it is in now", async () => {
    const w = await combined();
    const listed = (await (await fetch(url(w.server, `/api/inbox/threads?project=${w.from}`))).json()) as { sections: InboxListSection[] };
    expect(listed.sections.flatMap((section) => section.threads).map((row) => row.thread_id).sort()).toEqual([w.inLedger.thread_id, w.inClone.thread_id].sort());

    const batch = await post(w.server, `/api/inbox/projects/${w.from}/read`, {});
    expect(batch.status).toBe(200);
    expect(((await batch.json()) as { project: { id: string } | null }).project?.id).toBe(w.into);

    w.server.store.resolveThread(w.inClone.thread_id, true);
    const archived = (await (await fetch(url(w.server, `/api/inbox/threads/archived?project=${w.from}`))).json()) as { threads: { thread_id: string }[] };
    expect(archived.threads.map((row) => row.thread_id)).toEqual([w.inClone.thread_id]);
  });
});

describe("an agent in either folder of a combined project", () => {
  test("read_thread lists the threads of both, from either folder", async () => {
    const w = await combined();
    for (const folder of [w.ledger, w.clone]) {
      const listed = await tool(w.client, "read_thread", { project_path: folder, asked_by: "anyone" });
      expect(listed.threads.map((row: { id?: string; thread_id?: string }) => row.thread_id ?? row.id).sort()).toEqual([w.inLedger.thread_id, w.inClone.thread_id].sort());
      expect(listed.project.name).toBe("ledger");
    }
    // Undone: each folder lists its own again.
    await combine(w.server, w.from, null);
    const own = await tool(w.client, "read_thread", { project_path: w.clone, asked_by: "anyone" });
    expect(own.threads).toHaveLength(1);
  });

  test("search in this project finds the messages of both, once each, under one name", async () => {
    const w = await combined();
    for (const folder of [w.ledger, w.clone]) {
      const heron = await tool(w.client, "search", { query: "heron", project_path: folder });
      const marlin = await tool(w.client, "search", { query: "marlin", project_path: folder });
      expect([heron.total, marlin.total]).toEqual([1, 1]);
    }
    const everywhere = await tool(w.client, "search", { query: "carried", all_projects: true });
    expect(everywhere.total).toBe(2);
    expect(new Set(everywhere.results.map((row: { project?: string | { name: string } }) => (typeof row.project === "string" ? row.project : row.project?.name)))).toEqual(new Set(["ledger"]));
    // Undone: a search from one folder stays in it.
    await combine(w.server, w.from, null);
    expect((await tool(w.client, "search", { query: "heron", project_path: w.clone })).total).toBe(0);
  });

  test("cards made in either folder are one Board: same key answers, and a thread of the other folder links", async () => {
    const w = await combined();
    const fromLedger = await tool(w.client, "card", { op: "create", title: "Move ledger", idempotency_key: "one-card", project_path: w.ledger, agent_session: "ses_ledger", agent_host: "claude-code" });
    const again = await tool(w.client, "card", { op: "create", title: "Move ledger", idempotency_key: "one-card", project_path: w.clone, agent_session: "ses_clone", agent_host: "claude-code" });
    expect(again.card.id).toBe(fromLedger.card.id);
    // The card is the ledger's; the clone's agent links its own thread to it, and lists it.
    const linked = await tool(w.client, "card", { op: "link", card_id: fromLedger.card.id, thread_id: w.inClone.thread_id, project_path: w.clone, agent_session: "ses_clone", agent_host: "claude-code" });
    expect(linked.card.id).toBe(fromLedger.card.id);
    const listed = await tool(w.client, "card", { op: "list", asked_by: "anyone", project_path: w.clone, agent_session: "ses_clone", agent_host: "claude-code" });
    expect(listed.cards.map((card: { id: string }) => card.id)).toEqual([fromLedger.card.id]);
  });
});

describe("the window on a combined project", () => {
  test("Compose shows one project with the live sessions of both folders, and names the folder a session is in", async () => {
    const w = await combined();
    await poll(w.server, "ses_ledger", w.ledger);
    await poll(w.server, "ses_clone", w.clone);
    const projects = await composeProjects(w.server);
    expect(projects.map((entry) => entry.project.id)).toEqual([w.into]);
    const sessions = projects[0]!.sessions;
    expect(sessions.map((session) => session.session).sort()).toEqual(["ses_clone", "ses_ledger"]);
    expect(sessions.find((session) => session.session === "ses_clone")?.root).toBe(w.clone);
    expect(sessions.find((session) => session.session === "ses_ledger")?.root).toBeUndefined();
  });

  test("a thread offers the live sessions of either folder, and only its own folder's after an undo", async () => {
    const w = await combined();
    await poll(w.server, "ses_clone", w.clone);
    const offered = async () => ((await (await fetch(url(w.server, `/api/inbox/threads/${w.inLedger.thread_id}/sessions`))).json()) as { sessions: { session: string }[] }).sessions.map((session) => session.session);
    expect(await offered()).toContain("ses_clone");
    await combine(w.server, w.from, null);
    expect(await offered()).not.toContain("ses_clone");
  });

  test("Tag calls a session in the other folder \"here\": its project is the thread's", async () => {
    const w = await combined();
    await poll(w.server, "ses_clone", w.clone);
    const model = (await (await fetch(url(w.server, `/api/inbox/threads/${w.inLedger.thread_id}/taggable`))).json()) as { sessions: { session: string; project: { id: string | null; root: string } | null }[] };
    expect(model.sessions.find((session) => session.session === "ses_clone")?.project).toMatchObject({ id: w.into, root: w.clone });
  });

  test("an agent replying from the other folder stays in that thread's project; its relative files start at its own folder", async () => {
    const w = await combined();
    const sent = await send(w.client, { project_path: w.clone, reply_to: w.inLedger.message_id, body: "Marlin read it.", agent_session: "ses_clone" });
    expect(sent.thread_id).toBe(w.inLedger.thread_id);
    const thread = w.server.store.thread(w.inLedger.thread_id)!;
    expect(thread.messages.map((message) => message.project_id)).toEqual([w.into, w.into]);
    expect(thread.messages.at(-1)?.base_path).toBe(w.clone);
  });

  test("a reply into another project's thread is what it was: no folder is recorded", async () => {
    const w = await world();
    const inLedger = await send(w.client, { project_path: w.ledger, body: "Ledger.", agent_session: "ses_ledger" });
    await send(w.client, { project_path: w.other, body: "Billing.", agent_session: "ses_other" });
    await send(w.client, { project_path: w.other, reply_to: inLedger.message_id, body: "From billing.", agent_session: "ses_other" });
    expect(w.server.store.thread(inLedger.thread_id)!.messages.at(-1)?.base_path).toBeUndefined();
  });

  test("Settings keeps each folder's size; deleting the head leaves the other folder as its own project", async () => {
    const w = await combined();
    const store = (await (await fetch(url(w.server, "/api/inbox/settings"))).json()) as { store: { projects: { id: string; combined_into?: string; combined?: string[] }[] } };
    const usage = new Map(store.store.projects.map((project) => [project.id, project]));
    expect(usage.get(w.from)?.combined_into).toBe("ledger");
    expect(usage.get(w.into)?.combined).toEqual(["ledger-2"]);

    const removed = await post(w.server, `/api/inbox/projects/${w.into}/delete`, {});
    expect(removed.status).toBe(200);
    // The clone's thread is not gone, and it has a project again.
    const left = await rows(w.server);
    expect(left.map((row) => [row.thread_id, row.project.id])).toEqual([[w.inClone.thread_id, w.from]]);
    expect(w.server.store.listProjects().map((project: InboxProject) => project.id)).toContain(w.from);
  });

  test("deleting a combined folder takes only that folder's threads", async () => {
    const w = await combined();
    expect((await post(w.server, `/api/inbox/projects/${w.from}/delete`, {})).status).toBe(200);
    expect((await rows(w.server)).map((row) => row.thread_id)).toEqual([w.inLedger.thread_id]);
    expect(w.server.store.thread(w.inClone.thread_id)).toBeNull();
    expect(w.server.store.project(w.into)?.merged_into).toBeUndefined();
  });

  test("a project with no duplicates has nothing new in its answers", async () => {
    const w = await world();
    await send(w.client, { project_path: w.ledger, body: "Alone.", agent_session: "ses_ledger" });
    await send(w.client, { project_path: w.other, body: "Alone too.", agent_session: "ses_other" });
    await poll(w.server, "ses_ledger", w.ledger);
    const plan = await until(() => tidyPlan(w.server), () => true);
    expect(plan.combine).toBeUndefined();
    expect((await folders(w.server)).every((folder) => folder.combined === undefined)).toBe(true);
    const composed = await composeProjects(w.server);
    expect(composed.flatMap((project) => project.sessions).every((session) => session.root === undefined)).toBe(true);
    expect(w.server.store.listProjects().every((project: InboxProject) => project.merged_into === undefined && project.separated_from === undefined)).toBe(true);
  });
});

describe("Tidy's Combine projects", () => {
  test("a plan read runs no git: it reads the repo cache as it stands", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-combine-")));
    scratch.push(root);
    const reads: string[] = [];
    const server = await startInboxServer({
      dataDir: join(root, "data"),
      phones: false,
      readProjectRepo: async (folder) => {
        reads.push(folder);
        return null;
      },
    });
    servers.push(server);
    // Past the read of every project's origin at startup, and not in the cache: the Inbox did not resolve this one.
    await Bun.sleep(100);
    server.store.ensureProject({ name: "ledger", root: join(root, "ledger") });
    await tidyPlan(server);
    await Bun.sleep(20);
    expect(reads).toEqual([]);
  });

  test("offers a repository cloned twice on the list only, into the project with more threads, and counts it", async () => {
    const w = await world();
    await send(w.client, { project_path: w.clone, body: "One.", agent_session: "ses_clone" });
    const small = (await send(w.client, { project_path: w.clone, body: "Two.", agent_session: "ses_clone_b" })).project.id as string;
    const big = (await send(w.client, { project_path: w.ledger, body: "Only one here.", agent_session: "ses_ledger" })).project.id as string;
    await send(w.client, { project_path: w.other, body: "Another repository.", agent_session: "ses_other" });
    const plan = await until(() => tidyPlan(w.server), (found) => (found.combine?.length ?? 0) > 0);
    expect(plan.combine).toHaveLength(1);
    expect(plan.combine![0]).toMatchObject({ into: { id: small, root: w.clone }, from: { id: big, root: w.ledger }, why: "same repository" });
    expect(plan.count).toBe(1);
    const board = (await (await fetch(url(w.server, "/api/inbox/tidy?surface=board"))).json()) as InboxTidyPlan;
    expect(board.combine).toBeUndefined();
  });

  test("a combined pair stops being offered; a pair whose combine was undone is not offered again", async () => {
    const w = await combined();
    await until(() => tidyPlan(w.server), () => true);
    expect((await tidyPlan(w.server)).combine).toBeUndefined();
    await combine(w.server, w.from, null);
    await Bun.sleep(40);
    expect((await tidyPlan(w.server)).combine).toBeUndefined();
  });

  test("offers a project left in another's worktrees folder, read from the store, without touching either", async () => {
    const w = await world();
    const main = (await send(w.client, { project_path: w.ledger, body: "Main.", agent_session: "ses_ledger" })).project.id as string;
    // What an Inbox made before worktrees folded into their repository.
    const stale = w.server.store.ensureProject({ name: "old-branch", root: join(w.ledger, ".claude", "worktrees", "old-branch") });
    const plan = await until(() => tidyPlan(w.server), (found) => (found.combine?.length ?? 0) > 0);
    expect(plan.combine![0]).toMatchObject({ into: { id: main }, from: { id: stale.id } });
    expect(w.server.store.project(stale.id)?.merged_into).toBeUndefined();
  });
});
