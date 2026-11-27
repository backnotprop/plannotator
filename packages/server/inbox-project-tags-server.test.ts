/**
 * Project tags through the Inbox's real doors on a running Inbox (temp data dir, loopback): the list's `projects[]`
 * carrying `tags` only once a project is tagged (nothing looks different before), `POST /api/inbox/projects/:id/tags`
 * through the real handler and its window guards, `inbox/project-tags.json` (0600) across a restart, and `event: tags`
 * to a window when a project's tags change.
 *
 * The failures this guards: a list that sends `tags` (even empty) on untagged projects, or never sends them; a route
 * the handler does not reach, or reaches without the same-origin and page-session guards; a tag that does not hold
 * across a restart; and a project tag write that leaves the windows' lists stale (no `event: tags`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxInitiative } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "./inbox";

type Json = Record<string, any>;

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function start(dataDir: string) {
  const server = await startInboxServer({ dataDir, binaryPath: null, setAsideDelayMs: 60_000 });
  servers.push(server);
  const client = new Client({ name: "inbox-project-tags-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client };
}

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-project-tags-server-")));
  roots.push(root);
  const billing = join(root, "billing-svc");
  const site = join(root, "site");
  mkdirSync(billing, { recursive: true });
  mkdirSync(site, { recursive: true });
  const dataDir = join(root, "data");
  const { server, client } = await start(dataDir);
  const send = async (projectPath: string, body: string, session: string) =>
    (
      (await client.callTool({ name: "send_message", arguments: { project_path: projectPath, agent_session: session, agent_name: "Claude Code", body } })) as {
        structuredContent: { thread_id: string; message_id: string };
      }
    ).structuredContent;
  await send(billing, "Invoices are reconciled", "ses_a");
  await send(billing, "Refund job is green", "ses_b");
  await send(site, "Landing page copy is up", "ses_c");
  return { root, dataDir, server, client, billing, site };
}

const url = (server: InboxServer, path: string) => `http://127.0.0.1:${server.port}${path}`;
const post = (server: InboxServer, path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(url(server, path), { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) });

const listProjects = async (server: InboxServer): Promise<Json[]> => ((await (await fetch(url(server, "/api/inbox/threads?archived=exclude"))).json()) as { projects: Json[] }).projects;
/** The listed project whose folder is `root` (its name, the folder's, as a fallback). */
const projectAt = async (server: InboxServer, root: string): Promise<Json> => {
  const projects = await listProjects(server);
  const found = projects.find((p) => p.root === root) ?? projects.find((p) => p.name === root.split("/").pop());
  if (!found) throw new Error(`no listed project at ${root}: ${JSON.stringify(projects.map((p) => [p.name, p.root]))}`);
  return found;
};
const tagProject = (server: InboxServer, projectId: string, tag: string, on: boolean) => post(server, `/api/inbox/projects/${projectId}/tags`, { tag, on });
const makeTag = async (server: InboxServer, name: string) => ((await (await post(server, "/api/inbox/initiatives", { name })).json()) as { initiative: InboxInitiative }).initiative;

describe("project tags on a running Inbox", () => {
  test("the list's projects carry `tags` only once tagged; untick drops the key; kept in a 0600 file across a restart", async () => {
    const { dataDir, server, billing, site } = await setup();
    const work = await makeTag(server, "Work");
    // Nothing tagged: no project says `tags` at all, so the list reads exactly as before.
    const before = await listProjects(server);
    expect(before.length).toBeGreaterThanOrEqual(2);
    for (const project of before) expect("tags" in project).toBe(false);
    const a = await projectAt(server, billing);
    const b = await projectAt(server, site);

    const added = await tagProject(server, a.id, work.id, true);
    expect(added.status).toBe(200);
    expect(((await added.json()) as Json).tags).toEqual([work.id]);
    expect((await projectAt(server, billing)).tags).toEqual([work.id]);
    expect("tags" in (await projectAt(server, site))).toBe(false);
    expect(statSync(join(dataDir, "inbox", "project-tags.json")).mode & 0o777).toBe(0o600);

    // A restart keeps it.
    server.stop();
    servers.splice(servers.indexOf(server), 1);
    const again = (await start(dataDir)).server;
    expect((await projectAt(again, billing)).tags).toEqual([work.id]);
    expect("tags" in (await projectAt(again, site))).toBe(false);

    // Untick: the key goes again.
    const removed = await tagProject(again, a.id, work.id, false);
    expect(((await removed.json()) as Json).tags).toEqual([]);
    expect("tags" in (await projectAt(again, billing))).toBe(false);
    expect(b.id).not.toBe(a.id);
  });

  test("guards through the real handler: another site, a stale tab, GET, an unknown project or tag, a bad body", async () => {
    const { server, billing } = await setup();
    const work = await makeTag(server, "Work");
    const a = await projectAt(server, billing);
    const path = `/api/inbox/projects/${a.id}/tags`;
    expect(((await (await post(server, path, { tag: work.id, on: true }, { Origin: "https://evil.example" })).json()) as Json).code).toBe("cross_origin");
    expect((await post(server, path, { tag: work.id, on: true }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    const stale = await fetch(url(server, path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: "not-this-one", tag: work.id, on: true }) });
    expect(stale.status).toBe(409);
    expect((await fetch(url(server, path))).status).toBe(405);
    expect((await tagProject(server, "prj_01K70000000000000000000099", work.id, true)).status).toBe(404);
    expect((await tagProject(server, a.id, "ini_01K70000000000000000000099", true)).status).toBe(404);
    expect((await post(server, path, { tag: work.id, on: "yes" })).status).toBe(422);
    expect("tags" in (await projectAt(server, billing))).toBe(false);
  });

  test("a window hears `event: tags` when a project's tags change", async () => {
    const { server, billing } = await setup();
    const work = await makeTag(server, "Work");
    const a = await projectAt(server, billing);
    const controller = new AbortController();
    const stream = await fetch(url(server, `/api/inbox/events?cursor=${server.store.cursor()}&window=window-project-tags-1&permission=granted`), { signal: controller.signal });
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      while (!text.includes("event: hello")) text += decoder.decode((await reader.read()).value);
      expect((await tagProject(server, a.id, work.id, true)).status).toBe(200);
      const deadline = Date.now() + 1500;
      // One read in flight at a time, kept across the waits, so no chunk is read and dropped.
      let pending = reader.read();
      while (!text.includes("event: tags") && Date.now() < deadline) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const chunk = await Promise.race([pending, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), 200)))]);
        clearTimeout(timer);
        if (chunk === null) continue;
        if (chunk.done) break;
        text += decoder.decode(chunk.value);
        pending = reader.read();
      }
      pending.catch(() => {});
    } finally {
      controller.abort();
    }
    expect(text).toContain("event: tags\ndata: {}");
  });
});
