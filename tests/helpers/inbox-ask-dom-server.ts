/**
 * A real Inbox for the Ask AI window's DOM tests, as its own process (under
 * DOM_TESTS=1 happy-dom replaces Response, which Bun.serve cannot answer with).
 *
 *   bun tests/helpers/inbox-ask-dom-server.ts <data dir> <projects dir> <on | off>
 *
 * Seeds a project with one thread per test need, each owned by a live scripted
 * agent (tests/helpers/inbox-ask-agent.ts) on its own session: `first`,
 * `second`, `mine` (for a reply), `busy`, `moved`, `flaky`, `note`, `damaged`,
 * and `resolved`, which the person archived. `session-new-owner` owns nothing
 * until a test hands `moved` to it.
 * Prints one JSON line naming the threads, and `control`, the port a test
 * drives the agents through:
 *
 *   POST /busy     `{ session, busy }`
 *   POST /hand-off `{}`: session-new-owner replies in `moved`, and owns it now
 *   GET  /agent?session=…  `{ asked, interrupts }`
 *
 * Runs until killed. `on` or `off` is the setting. A question with "slowly" in
 * it is not answered for 20 seconds, and one with "flaky" in it fails the first
 * time it is asked.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startInboxServer } from "../../packages/server/inbox";
import { startScriptedAskAgent } from "./inbox-ask-agent";

const [dataDir, projectsDir, setting] = process.argv.slice(2);
if (!dataDir || !projectsDir) throw new Error("usage: inbox-ask-dom-server.ts <data dir> <projects dir> <on | off>");

const project = join(projectsDir, "api");
mkdirSync(project, { recursive: true });
process.env.PLANNOTATOR_DATA_DIR = dataDir;
const server = await startInboxServer({ dataDir, askAi: setting === "on", binaryPath: null });

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
      // The test's question comes back in the words, so a test can tell whose answer it reads.
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
