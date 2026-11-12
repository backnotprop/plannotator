import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startInboxServer } from "../../packages/server/inbox";
import { startScriptedAskAgent } from "./inbox-ask-agent";

const [dataDir, projectsDir] = process.argv.slice(2);
if (!dataDir || !projectsDir) throw new Error("usage: inbox-ask-dom-server.ts <data dir> <projects dir>");

const project = join(projectsDir, "api");
mkdirSync(project, { recursive: true });
process.env.PLANNOTATOR_DATA_DIR = dataDir;
const server = await startInboxServer({ dataDir, binaryPath: null });

const client = new Client({ name: "inbox-ask-dom", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));

async function agentSends(session: string, subject: string | undefined, body: string, reply_to?: string) {
  const result = await client.callTool({
    name: "send_message",
    arguments: { ...(subject ? { subject } : {}), body, project_path: project, agent_session: session, agent_host: "claude-code", agent_name: "Claude Code", ...(reply_to ? { reply_to } : {}) },
  });
  return result.structuredContent as { thread_id: string; message_id: string };
}

const failedOnce = new Set<string>();

const sessions = ["session-first", "session-second", "session-mine", "session-resolved", "session-busy", "session-moved", "session-new-owner", "session-flaky", "session-note", "session-damaged"];
const agents = new Map(
  sessions.map((session) => [
    session,
    startScriptedAskAgent({
      port: server.port,
      token: server.token,
      session,
      project,
      reply: async (text) => {
        const question = text.trim().split("\n").at(-1) ?? "";
        if (question.includes("slowly")) await new Promise((done) => setTimeout(done, 20_000));
        if (question.includes("flaky") && !failedOnce.has(question)) {
          failedOnce.add(question);
          throw new Error("The scripted agent failed this one.");
        }
        return `Answered: ${question}`;
      },
    }),
  ]),
);

const first = await agentSends("session-first", "Why did the retry fail?", "The retry budget ran out.");
const second = await agentSends("session-second", "Deploy notes", "Ready for the deploy.");
const mine = await agentSends("session-mine", "Reply here", "Tell me what you think.");
const busy = await agentSends("session-busy", "Busy agent", "Working on it.");
const moved = await agentSends("session-moved", "Moved thread", "Handing this on soon.");
const flaky = await agentSends("session-flaky", "Flaky agent", "This one fails once.");
const note = await agentSends("session-note", "Unanswered question", "Ask me something.");
const damaged = await agentSends("session-damaged", "Damaged chat", "This conversation file breaks.");
const resolved = await agentSends("session-resolved", "Old cleanup", "All done.");
server.store.resolveThread(resolved.message_id, true);

const control = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/busy") {
      const body = (await req.json()) as { session: string; busy: boolean };
      agents.get(body.session)!.setBusy(body.busy);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/hand-off") {
      await agentSends("session-new-owner", undefined, "I took this over.", moved.message_id);
      return Response.json({ ok: true });
    }
    const agent = agents.get(url.searchParams.get("session") ?? "")!;
    return Response.json({ asked: agent.asked, interrupts: agent.interrupts() });
  },
});

console.log(
  JSON.stringify({
    port: server.port,
    control: control.port,
    serverSession: server.serverSession,
    project,
    first: first.thread_id,
    second: second.thread_id,
    mine: mine.thread_id,
    busy: busy.thread_id,
    moved: moved.thread_id,
    flaky: flaky.thread_id,
    note: note.thread_id,
    damaged: damaged.thread_id,
    resolved: resolved.thread_id,
  }),
);

process.on("SIGTERM", () => {
  for (const agent of agents.values()) agent.stop();
  control.stop(true);
  server.stop();
  process.exit(0);
});
await new Promise(() => {});
