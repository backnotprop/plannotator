/**
 * A long Inbox thread for size checks on the MCP results
 * (packages/server/inbox-mcp-size.test.ts): an agent asks, the person
 * answers, `rounds` times, through the real doors (the MCP client for the
 * agent, the window's routes for the person). Every agent message carries a
 * paragraph of prose and a two-question block; every third one attaches a
 * file. The server must be one the caller started under a scratch data dir.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";

type Structured = Record<string, any>;

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Structured> {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent: Structured };
  if (result.isError) throw new Error(result.content[0]!.text);
  return result.structuredContent;
}

const PROSE =
  "I went through the retry worker again. The queue drains in order, the dead-letter path is wired, and the metrics land in the dashboard. " +
  "Two things still need your call before I go on; everything else in this step is done and pushed to the branch.";

export const LONG_THREAD_FIRST_CHOICE = "Exponential, capped at 30 s";

function body(round: number): string {
  return [
    `Step ${round}: ${PROSE}`,
    "",
    ":::question",
    `Round ${round}: which backoff should the worker use?`,
    "",
    "Holds up: the retry worker",
    "",
    `- [ ] ${LONG_THREAD_FIRST_CHOICE}`,
    "- [ ] Fixed 5 s",
    "",
    `Recommended: ${LONG_THREAD_FIRST_CHOICE}`,
    ":::",
    "",
    ":::question",
    `Round ${round}: ship it behind a flag?`,
    "",
    "- [ ] Yes",
    "- [ ] No",
    ":::",
  ].join("\n");
}

/**
 * `rounds` agent messages, each answered by the person except the last,
 * which stays open: 2 * rounds - 1 messages. With `answerLast`, the last one
 * is answered too, but only once the caller asks (the reply a wait sees).
 */
export async function seedLongThread(options: {
  client: Client;
  port: number;
  project: string;
  session?: string;
  rounds: number;
}): Promise<{ threadId: string; messageIds: string[]; lastAgentMessageId: string; answerLast: () => Promise<string> }> {
  const { client, port, project, rounds } = options;
  const session = options.session ?? "ses_long";
  writeFileSync(join(project, "notes.md"), "# Notes\n\nThe worker drains the queue in order.\n");
  let threadId = "";
  let last = "";
  let lastQuestions: { key: string; kind: string; prompt: string }[] = [];
  const messageIds: string[] = [];
  const answer = async (messageId: string, questions: typeof lastQuestions, round: number): Promise<string> => {
    const response = await fetch(`http://127.0.0.1:${port}/api/inbox/messages/${messageId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotency_key: `long-reply-${round}`,
        words: `Round ${round}: go ahead.`,
        questions: questions.map((q, i) => ({
          key: q.key,
          revision: 0,
          answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [i === 0 ? LONG_THREAD_FIRST_CHOICE : "Yes"] },
        })),
      }),
    });
    if (response.status !== 200) throw new Error(`reply ${round}: ${response.status} ${await response.text()}`);
    return ((await response.json()) as { reply: { id: string } }).reply.id;
  };
  for (let round = 1; round <= rounds; round++) {
    const sent = await call(client, "send_message", {
      project_path: project,
      body: body(round),
      agent_session: session,
      agent_name: "Claude Code",
      agent_host: "claude-code",
      idempotency_key: `long-${round}`,
      ...(threadId ? { reply_to: last } : {}),
      ...(round % 3 === 0 ? { attachments: ["notes.md"] } : {}),
    });
    threadId = sent.thread_id;
    last = sent.message_id;
    lastQuestions = sent.questions;
    messageIds.push(sent.message_id);
    if (round === rounds) break;
    messageIds.push(await answer(sent.message_id, sent.questions, round));
  }
  return { threadId, messageIds, lastAgentMessageId: last, answerLast: () => answer(last, lastQuestions, rounds) };
}
