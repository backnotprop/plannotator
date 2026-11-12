import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_SESSION_PROJECT_ENV, inboxProjectFolderFor, inboxSessionProjectFromEnv, runInboxMcpShim, type InboxSessionProject } from "./inbox-mcp-shim";

const scratch: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function folders() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-session-project-")));
  scratch.push(root);
  const top = join(root, "top");
  const sub = join(top, "repo", "src");
  mkdirSync(sub, { recursive: true });
  const file = join(root, "a-file");
  writeFileSync(file, "");
  return { root, top, sub, file };
}

const read = (value: string | undefined) => inboxSessionProjectFromEnv(value === undefined ? {} : { [INBOX_SESSION_PROJECT_ENV]: value });

describe("the value", () => {
  test("is <host>:<session id>:<absolute folder>; the folder keeps any colon after the second", () => {
    expect(read("claude-code:s1:/w/top")).toEqual({ host: "claude-code", session: "s1", folder: "/w/top" });
    expect(read("pi:ses-pi-one:/w/a:b")).toEqual({ host: "pi", session: "ses-pi-one", folder: "/w/a:b" });
  });

  test("anything else is no value", () => {
    for (const value of [undefined, "", "claude-code", "claude-code:s1", "claude-code::/w", "claude-code:s1:", "claude-code:s1:relative/top", ":s1:/w", "nobody:s1:/w", "constructor:s1:/w", "toString:s1:/w", "claude-code:has space:/w", "claude-code:-leading:/w"]) {
      expect(read(value)).toBeNull();
    }
  });
});

describe("the folder a call files under", () => {
  test("the session's folder only for that session, and only while it is a folder", () => {
    const f = folders();
    const mine: InboxSessionProject = { host: "claude-code", session: "s1", folder: f.top };
    expect(inboxProjectFolderFor(mine, { host: "claude-code", session: "s1" }, f.sub)).toBe(f.top);
    expect(inboxProjectFolderFor(mine, { host: null, session: "s1" }, f.sub)).toBe(f.top);
    expect(inboxProjectFolderFor(mine, { session: "s1" }, f.sub)).toBe(f.top);
    expect(inboxProjectFolderFor(mine, { host: "claude-code", session: "s2" }, f.sub)).toBe(f.sub);
    expect(inboxProjectFolderFor(mine, { host: "pi", session: "s1" }, f.sub)).toBe(f.sub);
    expect(inboxProjectFolderFor(mine, null, f.sub)).toBe(f.sub);
    expect(inboxProjectFolderFor(null, { host: "claude-code", session: "s1" }, f.sub)).toBe(f.sub);
    expect(inboxProjectFolderFor({ ...mine, folder: f.file }, { host: "claude-code", session: "s1" }, f.sub)).toBe(f.sub);
    expect(inboxProjectFolderFor({ ...mine, folder: join(f.root, "gone") }, { host: "claude-code", session: "s1" }, f.sub)).toBe(f.sub);
  });
});

describe("plannotator inbox mcp with a session project", () => {
  async function through(args: Record<string, unknown>, options: { cwd: string; sessionProject: InboxSessionProject | null; hostSession: { host: string; session: string; name: string } | null }) {
    const received: Record<string, unknown>[] = [];
    const fake = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { id: number; params?: { arguments?: Record<string, unknown> } };
        received.push(body.params?.arguments ?? {});
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "ok" }] } });
      },
    });
    cleanups.push(() => fake.stop(true));
    const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: args } });
    await runInboxMcpShim({
      dataDir: join(options.cwd, ".no-data"),
      cwd: options.cwd,
      ensureRunning: async () => ({ v: 1, pid: process.pid, port: fake.port, url: "", version: "test", token: "t", serverSession: "s", startedAt: "" }) as never,
      hostSession: options.hostSession as never,
      sessionProject: options.sessionProject,
      input: new Blob([`${request}\n`]).stream(),
      write: () => undefined,
    });
    expect(received).toHaveLength(1);
    return received[0]!;
  }

  test("fills the session's folder, never over a project_path the agent named, and not for another session", async () => {
    const f = folders();
    const sessionProject: InboxSessionProject = { host: "claude-code", session: "s1", folder: f.top };
    const hostSession = { host: "claude-code", session: "s1", name: "Claude Code" };
    expect((await through({ body: "hi" }, { cwd: f.sub, sessionProject, hostSession })).project_path).toBe(f.top);
    expect((await through({ body: "hi", project_path: f.sub }, { cwd: f.sub, sessionProject, hostSession })).project_path).toBe(f.sub);
    expect((await through({ body: "hi" }, { cwd: f.sub, sessionProject, hostSession: { ...hostSession, session: "nested" } })).project_path).toBe(f.sub);
    expect((await through({ body: "hi" }, { cwd: f.sub, sessionProject: null, hostSession })).project_path).toBe(f.sub);
  });
});
