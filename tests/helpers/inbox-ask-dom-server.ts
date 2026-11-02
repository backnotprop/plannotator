/**
 * A real Inbox for the Ask AI window's DOM tests, as its own process (under
 * DOM_TESTS=1 happy-dom replaces Response, which Bun.serve cannot answer with).
 *
 *   bun tests/helpers/inbox-ask-dom-server.ts <data dir> <projects dir> <on | off>
 *
 * Seeds a project with three threads, each owned by a live scripted agent
 * (tests/helpers/inbox-ask-agent.ts) on its own session: `first`, `second`,
 * `mine` (for a reply) and `resolved`, which the person archived.
 * Prints one JSON line `{ port, serverSession, project, first, second, mine, resolved }`,
 * and runs until killed. `on` or `off` is the setting. A question with "slowly"
 * in it is not answered for 20 seconds.
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
const server = await startInboxServer({ dataDir, askAi: setting === "on", binaryPath: null });

const client = new Client({ name: "inbox-ask-dom", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));

async function agentSends(session: string, subject: string, body: string) {
  const result = await client.callTool({
    name: "send_message",
    arguments: { subject, body, project_path: project, agent_session: session, agent_host: "claude-code", agent_name: "Claude Code" },
  });
  return result.structuredContent as { thread_id: string; message_id: string };
}

const agents = ["session-first", "session-second", "session-mine", "session-resolved"].map((session) =>
  startScriptedAskAgent({
    port: server.port,
    token: server.token,
    session,
    project,
    // The test's question comes back in the words, so a test can tell whose answer it reads.
    reply: async (text) => {
      const question = text.trim().split("\n").at(-1) ?? "";
      if (question.includes("slowly")) await new Promise((done) => setTimeout(done, 20_000));
      return `Answered: ${question}`;
    },
  }),
);

const first = await agentSends("session-first", "Why did the retry fail?", "The retry budget ran out.");
const second = await agentSends("session-second", "Deploy notes", "Ready for the deploy.");
const mine = await agentSends("session-mine", "Reply here", "Tell me what you think.");
const resolved = await agentSends("session-resolved", "Old cleanup", "All done.");
server.store.resolveThread(resolved.message_id, true);

console.log(JSON.stringify({ port: server.port, serverSession: server.serverSession, project, first: first.thread_id, second: second.thread_id, mine: mine.thread_id, resolved: resolved.thread_id }));

process.on("SIGTERM", () => {
  for (const agent of agents) agent.stop();
  server.stop();
  process.exit(0);
});
await new Promise(() => {});
