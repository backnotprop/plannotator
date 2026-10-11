/**
 * Each Inbox project's git `origin` on the thread payload (#1840), so the
 * window can link bare `#123` refs: a real Inbox on loopback, an agent
 * writing through the official MCP client, and temp git repositories with
 * fake remote URLs (nothing is fetched; `git remote get-url` only reads
 * config). Every test uses its own temp data dir.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxProjectRepo } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "./inbox";
import { createInboxRepoCache, readInboxProjectRepo } from "./inbox-repos";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

// Nothing here may reach the real tailscale CLI: a trap fails loudly first on
// PATH. The user's git config stays out too (an insteadOf rule rewrites the
// URL `remote get-url` prints).
const ENV_KEYS = ["PATH", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-repos-bin-")));
  roots.push(bin);
  writeFileSync(join(bin, "tailscale"), "#!/bin/sh\necho 'inbox-repos.test: tailscale must not run' >&2\nexit 97\n");
  chmodSync(join(bin, "tailscale"), 0o755);
  process.env.PATH = `${bin}:${saved.PATH ?? ""}`;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-repos-")));
  roots.push(root);
  return root;
}

function gitProject(root: string, name: string, origin: string | null): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  if (origin) Bun.spawnSync(["git", "remote", "add", "origin", origin], { cwd: dir });
  return dir;
}

async function send(server: InboxServer, projectPath: string, body: string): Promise<string> {
  const client = new Client({ name: "inbox-repos-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const result = (await client.callTool({ name: "send_message", arguments: { project_path: projectPath, body } })) as {
    structuredContent: { thread_id: string };
  };
  return result.structuredContent.thread_id;
}

async function threadRepo(server: InboxServer, threadId: string): Promise<InboxProjectRepo | null | undefined> {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${threadId}`);
  return ((await response.json()) as { thread: { project: { repo?: InboxProjectRepo | null } } }).thread.project.repo;
}

/** The thread's repo once the background resolve has landed (a read never waits for git). */
async function settledRepo(server: InboxServer, threadId: string): Promise<InboxProjectRepo | null | undefined> {
  for (let i = 0; i < 100; i++) {
    const repo = await threadRepo(server, threadId);
    if (repo) return repo;
    await Bun.sleep(30);
  }
  return threadRepo(server, threadId);
}

test("a git project's origin rides on the thread payload; a folder without git, or without origin, reads null", async () => {
  const root = tempRoot();
  const widgets = gitProject(root, "widgets", "git@github.com:acme/widgets.git");
  const noOrigin = gitProject(root, "scratch", null);
  const notes = join(root, "notes");
  mkdirSync(notes);
  const server = await startInboxServer({ dataDir: join(root, "data") });
  servers.push(server);

  const notesThread = await send(server, notes, "Notes from the meeting.");
  const scratchThread = await send(server, noOrigin, "A local experiment.");
  const widgetsThread = await send(server, widgets, "This fixes #123.");

  expect(await settledRepo(server, widgetsThread)).toEqual({ display: "acme/widgets", host: "github.com" });
  // The field is always present on the thread payload, null when there is no origin.
  expect(await threadRepo(server, notesThread)).toBeNull();
  expect(await threadRepo(server, scratchThread)).toBeNull();
  // The same answers straight from git, so null here is the resolved answer, not a pending one.
  expect(await readInboxProjectRepo(notes)).toBeNull();
  expect(await readInboxProjectRepo(noOrigin)).toBeNull();
});

test("an Inbox that starts on an existing store resolves its projects' remotes; GitLab subgroups and https URLs parse", async () => {
  const root = tempRoot();
  const dataDir = join(root, "data");
  const platform = gitProject(root, "platform", "https://gitlab.example.com/group/sub/platform.git");
  const first = await startInboxServer({ dataDir });
  servers.push(first);
  const threadId = await send(first, platform, "See #7.");
  first.stop();
  servers.splice(servers.indexOf(first), 1);

  // A new process, no new message: the repo comes from the resolve at start.
  const second = await startInboxServer({ dataDir });
  servers.push(second);
  expect(await settledRepo(second, threadId)).toEqual({ display: "group/sub/platform", host: "gitlab.example.com" });
});

test("the cache answers without waiting, dedupes a running resolve, and refreshes a stale entry in the background", async () => {
  let clock = 0;
  const calls: string[] = [];
  let answer: InboxProjectRepo | null = { display: "acme/one", host: "github.com" };
  const cache = createInboxRepoCache({
    ttlMs: 1_000,
    now: () => clock,
    read: async (root) => {
      calls.push(root);
      return answer;
    },
  });
  // Unknown: null now, one resolve started (a second read joins it).
  expect(cache.get("/r")).toBeNull();
  expect(cache.get("/r")).toBeNull();
  await cache.refresh("/r");
  expect(calls).toEqual(["/r"]);
  expect(cache.get("/r")).toEqual({ display: "acme/one", host: "github.com" });
  expect(calls).toEqual(["/r"]);

  // Stale: the old answer now, the new one after the background resolve.
  answer = { display: "acme/two", host: "github.com" };
  clock = 1_000;
  expect(cache.get("/r")).toEqual({ display: "acme/one", host: "github.com" });
  await cache.refresh("/r");
  expect(cache.get("/r")).toEqual({ display: "acme/two", host: "github.com" });
});
