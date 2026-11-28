/**
 * A file an agent's message names, on a thread that lives on another linked machine (approval
 * "inbox-file-refs-open-viewer"; one experience across the person's devices). Two real Inboxes linked both ways
 * through the CLI pairing, every proof made both ways: each machine says it takes file refs (mark `file-refs`); the
 * window here reads the file there through the forward, and a comment attaches it to the message there, once; an
 * agent's or a script's bare call through the forward reads and attaches nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createInboxWorld, destroyInboxWorld, registry, removeStubbedHtml, stubBuiltHtml, waitFor, worldEnv, type InboxWorld } from "../../tests/helpers/inbox-world";

type Json = Record<string, any>;

interface Machine {
  w: InboxWorld;
  name: string;
  id: string;
  calls: string;
  /** The agent message on this machine that names `docs/plan.md`. */
  message: { id: string; thread: string };
}

const base = (m: Machine) => `http://127.0.0.1:${registry(m.w).port}`;

function cli(m: Machine, ...args: string[]): { code: number; out: string; err: string } {
  const run = Bun.spawnSync([join(m.w.bin, "plannotator"), "inbox", ...args], { env: { ...(process.env as Record<string, string>), ...worldEnv(m.w), PLANNOTATOR_UPDATE_CHECK: "0", PLANNOTATOR_INBOX_NOTES: "0" }, cwd: m.w.root });
  return { code: run.exitCode ?? -1, out: run.stdout.toString(), err: run.stderr.toString() };
}

async function getJson(m: Machine, path: string): Promise<Json> {
  return (await (await fetch(`${base(m)}${path}`)).json()) as Json;
}

/** The window's own request: its Origin, `Sec-Fetch-Site: same-origin`, and (for a write) this run's page session. */
const windowGet = (m: Machine, path: string) => fetch(`${base(m)}${path}`, { headers: { "Sec-Fetch-Site": "same-origin" } });
async function windowPost(m: Machine, path: string, body: Json): Promise<Response> {
  const { serverSession } = await getJson(m, "/api/inbox/health");
  return fetch(`${base(m)}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base(m), "Sec-Fetch-Site": "same-origin" }, body: JSON.stringify({ serverSession, ...body }) });
}
/** The same request as an agent's or a script's bare call makes it. */
const barePost = (m: Machine, path: string, body: Json) => fetch(`${base(m)}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function agentNames(m: Machine): Promise<{ id: string; thread: string }> {
  const client = new Client({ name: "inbox-file-refs-linked", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base(m)}/mcp`)));
  try {
    const sent = (await client.callTool({ name: "send_message", arguments: { body: "The plan is in `docs/plan.md`; start at step 2.", project_path: m.w.project, agent_session: `ses-${m.name}`, agent_host: "claude-code" } })) as { structuredContent: { thread_id: string; message_id: string } };
    return { id: sent.structuredContent.message_id, thread: sent.structuredContent.thread_id };
  } finally {
    await client.close().catch(() => {});
  }
}

const viewQuery = (there: Machine) => new URLSearchParams({ thread: there.message.thread, message: there.message.id, path: "docs/plan.md" }).toString();
const attachBody = (there: Machine, key: string) => ({ thread: there.message.thread, message: there.message.id, path: "docs/plan.md", idempotency_key: key });

describe("a file a message names, on a linked machine's thread, two real Inboxes linked both ways", () => {
  let stubs: string[] = [];
  let A: Machine;
  let B: Machine;

  beforeAll(async () => {
    stubs = stubBuiltHtml();
    const machines: Machine[] = [];
    for (const name of ["MacBook", "Mini"]) {
      const w = createInboxWorld(`plannotator-file-refs-${name.toLowerCase()}-`, `file-refs-${name}`, "file-refs");
      const calls = join(w.root, "stand-in-calls.txt");
      for (const tool of ["tailscale", "claude"]) {
        writeFileSync(join(w.bin, tool), `#!/bin/sh\necho "${tool} $*" >> '${calls}'\nexit 1\n`);
        chmodSync(join(w.bin, tool), 0o755);
      }
      mkdirSync(join(w.project, "docs"), { recursive: true });
      writeFileSync(join(w.project, "docs", "plan.md"), `# The plan on ${name}\n\n1. Read.\n2. Retry the webhook on ${name}.\n`);
      const m: Machine = { w, name, id: "", calls, message: { id: "", thread: "" } };
      const started = cli(m, "--background");
      if (started.code !== 0) throw new Error(`inbox --background failed: ${started.err}`);
      m.id = (await getJson(m, "/api/inbox/health")).inbox_id as string;
      m.message = await agentNames(m);
      machines.push(m);
    }
    [A, B] = machines as [Machine, Machine];
    const offered = cli(B, "link", "--offer");
    expect(offered.code).toBe(0);
    const linked = cli(A, "link", offered.out.trim(), "--address", base(B), "--back", base(A));
    if (linked.code !== 0) throw new Error(`link failed: ${linked.err}`);
    expect(linked.out).toContain("both ways");
  }, 90_000);

  afterAll(async () => {
    for (const m of [A, B]) {
      if (!m) continue;
      expect(existsSync(m.calls)).toBe(false);
      await destroyInboxWorld(m.w);
    }
    removeStubbedHtml(stubs);
  });

  const both = () =>
    [
      [A, B],
      [B, A],
    ] as const;

  test("each machine offers file refs on the other's threads: its list names the mark", async () => {
    for (const [here, there] of both()) {
      const listed = await waitFor(`${here.name} has read ${there.name}'s list`, async () => ((await getJson(here, "/api/inbox/machines")).machines as Json[]).find((m) => m.id === there.id && (m.marks as string[]).length > 0) ?? null);
      expect(listed.marks).toContain("file-refs");
    }
  }, 30_000);

  test("the window reads the file there through the forward; a bare call does not", async () => {
    for (const [here, there] of both()) {
      const read = await windowGet(here, `/api/inbox/m/${there.id}/open-in/file/view?${viewQuery(there)}`);
      expect(read.status).toBe(200);
      const view = (await read.json()) as Json;
      expect(view).toMatchObject({ found: true, name: "plan.md" });
      // That machine's file, never this one's.
      expect(view.contents).toContain(`Retry the webhook on ${there.name}`);
      const bare = await fetch(`${base(here)}/api/inbox/m/${there.id}/open-in/file/view?${viewQuery(there)}`);
      expect(bare.status).toBe(403);
      expect(((await bare.json()) as Json).code).toBe("window_only");
    }
  }, 30_000);

  test("a comment from the window attaches it to the message there, once; a bare call attaches nothing", async () => {
    for (const [here, there] of both()) {
      const route = `/api/inbox/m/${there.id}/open-in/file/attach`;
      const refused = await barePost(here, route, attachBody(there, `bare-${here.name}`));
      expect(refused.status).toBe(403);
      expect(((await getJson(there, `/api/inbox/threads/${there.message.thread}`)).thread.messages[0].attachments ?? []).length).toBe(0);

      const first = await windowPost(here, route, attachBody(there, `first-${here.name}`));
      expect(first.status).toBe(200);
      const attachment = ((await first.json()) as Json).attachment;
      expect(attachment).toMatchObject({ name: "plan.md" });
      // A second press (a new key) answers the same attachment: the file is added to its message once.
      const again = await windowPost(here, route, attachBody(there, `again-${here.name}`));
      expect(((await again.json()) as Json).attachment.id).toBe(attachment.id);
      const own = await getJson(there, `/api/inbox/threads/${there.message.thread}`);
      expect((own.thread.messages[0].attachments as Json[]).map((a) => a.id)).toEqual([attachment.id]);
    }
  }, 60_000);
});
