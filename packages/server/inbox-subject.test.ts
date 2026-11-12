import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { GUIDE_BRIEF_EXAMPLE } from "./inbox-guides";
import { startInboxServer, type InboxServer } from "./inbox";
import { LEAKED_SUBJECT, LEAKED_SUBJECT_SHOWN, seedLeakedSubjects } from "../../tests/helpers/inbox-leaked-subject";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-subject-")));
  roots.push(root);
  const project = join(root, "workspaces");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "rollup.md"), "# Roll-up\n");
  return { project, dataDir: join(root, "data") };
}

async function start(dataDir: string): Promise<{ server: InboxServer; client: Client }> {
  const server = await startInboxServer({ dataDir });
  servers.push(server);
  const client = new Client({ name: "inbox-subject-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client };
}

type ToolAnswer = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, any> };
const call = async (client: Client, name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as unknown as ToolAnswer;
const get = async (server: InboxServer, path: string) => (await fetch(`http://127.0.0.1:${server.port}${path}`)).text();

describe("send_message and submit_guide refuse a subject that is not one line", () => {
  test("leaked tool-call text: refused before anything is written; the corrected retry with the same key lands once", async () => {
    const { project, dataDir } = world();
    const { server, client } = await start(dataDir);
    const args = { project_path: project, agent_session: "ses_ws", body: "Everything of mine that waits on you.", attachments: ["rollup.md"], idempotency_key: "ws-rollup-2026-10-20-a" };

    const refused = await call(client, "send_message", { ...args, subject: LEAKED_SUBJECT });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/^validation_error: subject: contains tool-call text/);
    expect(refused.content[0]!.text).toContain("subject alone");
    expect(refused.content[0]!.text).toContain("If you meant to write that text, reword it without the angle brackets.");
    expect(JSON.parse(await get(server, "/api/inbox/projects")).projects).toEqual([]);
    const blobs = join(dataDir, "inbox", "blobs");
    expect(existsSync(blobs) ? readdirSync(blobs) : []).toEqual([]);

    const lineBreak = await call(client, "send_message", { ...args, subject: "Roll-up\nsecond line" });
    expect(lineBreak.content[0]!.text).toMatch(/^validation_error: subject: must be one line/);

    const sent = await call(client, "send_message", { ...args, subject: LEAKED_SUBJECT_SHOWN });
    expect(sent.isError).toBeFalsy();
    const again = await call(client, "send_message", { ...args, subject: LEAKED_SUBJECT_SHOWN });
    expect(again.structuredContent).toMatchObject({ message_id: sent.structuredContent!.message_id, replayed: true });
    const list = JSON.parse(await get(server, "/api/inbox/threads"));
    const rows = list.sections.flatMap((s: { threads: { subject: string }[] }) => s.threads);
    expect(rows.map((r: { subject: string }) => r.subject)).toEqual([LEAKED_SUBJECT_SHOWN]);
  });

  test("submit_guide refuses it the same way", async () => {
    const { project, dataDir } = world();
    const { server, client } = await start(dataDir);
    const refused = await call(client, "submit_guide", { project_path: project, ...GUIDE_BRIEF_EXAMPLE, agent_session: "ses_g", subject: LEAKED_SUBJECT });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/^validation_error: subject: contains tool-call text/);
    expect(JSON.parse(await get(server, "/api/inbox/projects")).projects).toEqual([]);
  });

  test("the schema tells agents a subject is one line", async () => {
    const { dataDir } = world();
    const { client } = await start(dataDir);
    const tools = (await client.listTools()).tools;
    for (const name of ["send_message", "submit_guide"]) {
      const schema = tools.find((t) => t.name === name)!.inputSchema as { properties: Record<string, { description?: string }> };
      expect(schema.properties.subject!.description).toContain("one-line");
    }
  });
});

describe("a subject an older Inbox kept verbatim is served as shown", () => {
  test("list, thread, search, read_thread and the event stream show the first line without the markup", async () => {
    const { project, dataDir } = world();
    const [id] = seedLeakedSubjects(dataDir, [{ name: "workspaces", root: project }]);
    const { server, client } = await start(dataDir);
    const answers = {
      list: await get(server, "/api/inbox/threads"),
      thread: await get(server, `/api/inbox/threads/${id}`),
      search: await get(server, "/api/inbox/search?q=everything"),
      readThread: JSON.stringify(await call(client, "read_thread", { thread_id: id, project_path: project, agent_session: "ses_r" })),
      readList: JSON.stringify(await call(client, "read_thread", { project_path: project, agent_session: "ses_r", asked_by: "anyone" })),
    };
    for (const [where, text] of Object.entries(answers)) {
      expect(text, where).toContain(LEAKED_SUBJECT_SHOWN);
      expect(text, where).not.toContain("</subject>");
      expect(text, where).not.toContain("idempotency_key\\\">");
      expect(text, where).not.toContain("ws-rollup");
    }
    const thread = JSON.parse(answers.thread).thread;
    expect(thread.subject).toBe(LEAKED_SUBJECT_SHOWN);
    expect(thread.messages[0].subject).toBe(LEAKED_SUBJECT_SHOWN);

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${server.port}/api/inbox/events?cursor=0`, { signal: controller.signal });
    const reader = response.body!.getReader();
    let text = "";
    while (!text.includes(`"id":"${id}"`)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    controller.abort();
    expect(text).toContain(`"subject":${JSON.stringify(LEAKED_SUBJECT_SHOWN)}`);
    expect(text).not.toContain("</subject>");
  });
});
