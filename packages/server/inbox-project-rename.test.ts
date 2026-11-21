/**
 * Rename… in the project menu through the Inbox's real doors:
 * `POST /api/inbox/projects/:id/name` on a running Inbox (temp data dir,
 * loopback), with real git repositories and linked worktrees in temp
 * folders and the official MCP client for the agent. What can regress: a
 * worktree's message reading the folder's name instead of the person's (it
 * files under the main checkout's project id), agents or search not
 * following the rename, Reset not going back, the route skipping a guard the
 * other window writes have (another site, another session's tab, a GET), and
 * an empty name or a missing project being taken.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxListSection } from "@plannotator/core/inbox-types";
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

/** The person's layout: `acme/main` holds the repository, its worktrees sit beside it; another repo also checked out as `main`. */
async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-rename-")));
  scratch.push(root);
  const main = join(root, "acme", "main");
  mkdirSync(main, { recursive: true });
  git(main, "init", "-q");
  git(main, "commit", "-q", "--allow-empty", "-m", "init");
  const featX = join(root, "acme", "feat-x");
  const fixY = join(root, "acme", "fix-y");
  git(main, "worktree", "add", "-q", featX, "-b", "feat-x");
  git(main, "worktree", "add", "-q", fixY, "-b", "fix-y");
  const initech = join(root, "initech", "main");
  mkdirSync(initech, { recursive: true });
  git(initech, "init", "-q");
  const server = await startInboxServer({ dataDir: join(root, "data"), phones: false });
  servers.push(server);
  const client = new Client({ name: "inbox-project-rename-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { root, main, featX, fixY, initech, server, client };
}

async function send(client: Client, args: Record<string, unknown>): Promise<Record<string, any>> {
  const result = (await client.callTool({ name: "send_message", arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };
  if (result.isError) throw new Error(result.content[0]!.text);
  return result.structuredContent;
}

const url = (server: InboxServer, path: string) => `http://127.0.0.1:${server.port}${path}`;
const post = (server: InboxServer, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url(server, path), { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

async function rowNames(server: InboxServer): Promise<Map<string, string>> {
  const model = (await (await fetch(url(server, "/api/inbox/threads"))).json()) as { sections: InboxListSection[] };
  return new Map(model.sections.flatMap((s) => s.threads.map((r) => [r.thread_id, r.project.name] as const)));
}

type SearchRow = { type: string; name?: string; project?: { name: string } };

/** Every row a search answers, once the index is built. */
async function searchRows(server: InboxServer, q: string): Promise<SearchRow[]> {
  for (let i = 0; i < 100; i++) {
    const answer = (await (await fetch(url(server, `/api/inbox/search?q=${encodeURIComponent(q)}`))).json()) as { indexing: boolean; groups: Record<string, SearchRow[]> | null };
    if (!answer.indexing && answer.groups) return Object.values(answer.groups).flat();
    await Bun.sleep(50);
  }
  throw new Error("the search index was not built");
}

describe("POST /api/inbox/projects/:id/name", () => {
  test("worktrees under the project show the name: a new message from a worktree, the rows, agents and search read it", async () => {
    const w = await world();
    const fromMain = await send(w.client, { project_path: w.main, subject: "From main", body: "From the main checkout.", agent_session: "ses_main" });
    const fromFeat = await send(w.client, { project_path: w.featX, subject: "From feat-x", body: "From a worktree.", agent_session: "ses_feat" });
    await send(w.client, { project_path: w.initech, subject: "Other main", body: "Another repo named main.", agent_session: "ses_ini" });
    expect(fromFeat.project.id).toBe(fromMain.project.id);
    // Two repositories checked out as `main`: before the rename each names its parent.
    expect(w.server.store.project(fromMain.project.id)?.name).toBe("main · acme");

    const renamed = await post(w.server, `/api/inbox/projects/${fromMain.project.id}/name`, { name: "  acme  " });
    expect(renamed.status).toBe(200);
    const answer = (await renamed.json()) as { project: { id: string; name: string; display_name: string; key: string; root: string } };
    expect(answer.project).toMatchObject({ id: fromMain.project.id, name: "acme", display_name: "acme", root: w.main });

    // A worktree the project has not heard from yet still files under it, and the agent reads the person's name.
    const fromFix = await send(w.client, { project_path: w.fixY, subject: "From fix-y", body: "From the other worktree.", agent_session: "ses_fix" });
    expect(fromFix.project).toMatchObject({ id: fromMain.project.id, name: "acme" });
    expect(w.server.store.listProjects().map((p) => p.root).sort()).toEqual([w.main, w.initech].sort());
    // Every row of the project reads it; the other `main` is alone now.
    const rows = await rowNames(w.server);
    expect(rows.get(fromMain.thread_id)).toBe("acme");
    expect(rows.get(fromFeat.thread_id)).toBe("acme");
    expect(rows.get(fromFix.thread_id)).toBe("acme");
    expect([...rows.values()].filter((name) => name === "main")).toHaveLength(1);
    // Search finds the project by its new name and names its threads with it.
    const found = await searchRows(w.server, "acme");
    expect(found.some((r) => r.type === "project" && r.name === "acme")).toBe(true);
    const named = (await searchRows(w.server, "worktree")).map((r) => r.project?.name);
    expect(named.length).toBeGreaterThan(0);
    expect(named.every((name) => name === "acme")).toBe(true);
  });

  test("null resets to the folder's name; the record keeps its id, key and root throughout", async () => {
    const w = await world();
    const sent = await send(w.client, { project_path: w.main, body: "Hello.", agent_session: "ses_main" });
    const id = sent.project.id as string;
    const before = w.server.store.project(id)!;
    expect((await post(w.server, `/api/inbox/projects/${id}/name`, { name: "acme" })).status).toBe(200);
    const reset = await post(w.server, `/api/inbox/projects/${id}/name`, { name: null });
    expect(reset.status).toBe(200);
    const project = ((await reset.json()) as { project: Record<string, unknown> }).project;
    expect(project.name).toBe("main");
    expect("display_name" in project).toBe(false);
    expect(w.server.store.project(id)).toMatchObject({ id, key: before.key, root: before.root });
    expect((await rowNames(w.server)).get(sent.thread_id)).toBe("main");
  });

  test("refuses an empty name, a missing name field, a missing project, and requests without the window's guards", async () => {
    const w = await world();
    const sent = await send(w.client, { project_path: w.main, body: "Hello.", agent_session: "ses_main" });
    const id = sent.project.id as string;
    const path = `/api/inbox/projects/${id}/name`;
    for (const body of [{ name: "" }, { name: "   " }, { name: "x".repeat(65) }, {}, { name: 42 }]) {
      const refused = await post(w.server, path, body);
      expect(refused.status).toBe(422);
      expect(((await refused.json()) as { code: string }).code).toBe("validation_error");
    }
    expect((await post(w.server, "/api/inbox/projects/prj_00000000000000000000000000/name", { name: "acme" })).status).toBe(404);
    expect((await post(w.server, "/api/inbox/projects/nope/name", { name: "acme" })).status).toBe(422);
    // Another site's page, a tab of an older Inbox, a GET.
    const cross = await post(w.server, path, { name: "acme" }, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" });
    expect(cross.status).toBe(403);
    expect(((await cross.json()) as { code: string }).code).toBe("cross_origin");
    expect((await post(w.server, path, { name: "acme", serverSession: "an-older-inbox" })).status).toBe(409);
    expect((await fetch(url(w.server, path))).status).toBe(405);
    // Nothing above changed anything.
    expect(w.server.store.project(id)?.display_name).toBeUndefined();
    expect(w.server.store.project(id)?.name).toBe("main");
  });
});
