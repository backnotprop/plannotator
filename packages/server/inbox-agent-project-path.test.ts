/**
 * The Pi / OpenCode connection (InboxAgentConnection) with an agent-named
 * project_path, against a real Inbox in this process: the thread lands in the
 * named project and relative attachments resolve against it; a path that is
 * not an existing folder is refused before the Inbox is reached (with the
 * Inbox stopped, its start command never runs).
 */
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverInboxTools, InboxAgentConnection } from "@plannotator/shared/inbox/agent-link";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-project-path-")));
  roots.push(root);
  const repo = join(root, "api");
  const notes = join(root, "meeting-notes");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(notes, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  writeFileSync(join(repo, "scripts", "replay.sh"), "#!/bin/sh\necho replay\n");
  // The command the connection would run to start a stopped Inbox: it only leaves a mark.
  const marker = join(root, "inbox-started");
  const command = join(root, "fake-plannotator");
  writeFileSync(command, `#!/bin/sh\necho "$@" >> '${marker}'\nexit 1\n`);
  chmodSync(command, 0o755);
  return { root, repo, notes, marker, command, dataDir: join(root, "data") };
}

async function threadRoot(server: InboxServer, threadId: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${threadId}`);
  return ((await response.json()) as { thread: { project: { root: string } } }).thread.project.root;
}

test("project_path names the project: the thread lands there and relative attachments resolve against it; without it, the working folder", async () => {
  const w = world();
  const server = await startInboxServer({ dataDir: w.dataDir });
  servers.push(server);
  const tools = (await discoverInboxTools(w.dataDir))!;
  const connection = new InboxAgentConnection({ dataDir: w.dataDir, host: "pi", agentName: "Pi", tools, command: w.command });
  const at = { sessionId: "ses_notes", cwd: w.notes };

  const named = await connection.callTool({ action: "send_message", body: "The script I ran.", project_path: "../api", attachments: ["scripts/replay.sh"], thread: "replay" }, at);
  expect(named.isError).toBe(false);
  const sent = JSON.parse(named.text.slice(named.text.indexOf("{"))) as { thread_id: string; attachments: { path: string; kind: string }[] };
  expect(await threadRoot(server, sent.thread_id)).toBe(w.repo);
  expect(sent.attachments[0]).toMatchObject({ path: join(w.repo, "scripts", "replay.sh"), kind: "code" });

  const absolute = await connection.callTool({ action: "send_message", body: "Absolute.", project_path: w.repo, thread: "replay" }, at);
  expect(JSON.parse(absolute.text.slice(absolute.text.indexOf("{"))).thread_id).toBe(sent.thread_id);

  const plain = await connection.callTool({ action: "send_message", body: "From my notes." }, at);
  const plainThread = JSON.parse(plain.text.slice(plain.text.indexOf("{"))) as { thread_id: string };
  expect(await threadRoot(server, plainThread.thread_id)).toBe(w.notes);
  expect(existsSync(w.marker)).toBe(false);
});

test("a project_path that is not an existing folder is refused before the Inbox is reached", async () => {
  const w = world();
  const server = await startInboxServer({ dataDir: w.dataDir });
  const tools = (await discoverInboxTools(w.dataDir))!;
  server.stop();
  const connection = new InboxAgentConnection({ dataDir: w.dataDir, host: "opencode", agentName: "OpenCode", tools, command: w.command });
  const at = { sessionId: "ses_x", cwd: w.notes };
  for (const bad of ["../missing", join(w.repo, "scripts", "replay.sh"), "bad\npath"]) {
    const result = await connection.callTool({ action: "send_message", body: "x", project_path: bad }, at);
    expect(result.isError, bad).toBe(true);
    expect(result.text).toContain("project_path");
  }
  // The stopped Inbox was never started for these calls.
  expect(existsSync(w.marker)).toBe(false);
  // A good path does reach for the Inbox (and starts it, here the fake that only marks).
  await connection.callTool({ action: "send_message", body: "x", project_path: "../api" }, at);
  expect(existsSync(w.marker)).toBe(true);
});
