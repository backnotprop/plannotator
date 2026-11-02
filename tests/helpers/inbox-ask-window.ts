/**
 * Ask AI as the Inbox window asks: its requests with its headers, then a fresh
 * AI session on the provider POST /ask named, then the query. For tests and for
 * tests/manual/inbox-ask-claude.ts, which aims them at a real Claude Code session.
 */
import type { InboxAskConversation, InboxAskTurn } from "../../packages/shared/inbox/ask";

/** A running Inbox: an `InboxServer`, or what the registry says. */
export interface AskWindowTarget {
  port: number;
  serverSession: string;
}

export interface AskAnswer {
  turn: InboxAskTurn;
  conversation: InboxAskConversation;
  provider_id: string | null;
  reason?: string;
  running?: boolean;
}

export interface AskQueryMessage {
  type: string;
  code?: string;
  delta?: string;
}

export function fromWindow(target: AskWindowTarget, path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  return fetch(`http://127.0.0.1:${target.port}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json", Origin: `http://127.0.0.1:${target.port}` },
    ...(body ? { body: JSON.stringify({ serverSession: target.serverSession, ...body }) } : {}),
    ...(signal ? { signal } : {}),
  });
}

export const postAsk = (target: AskWindowTarget, threadId: string, turnId: string, question: string): Promise<Response> =>
  fromWindow(target, `/api/inbox/threads/${threadId}/ask`, { turn_id: turnId, question });

export async function readAsk(target: AskWindowTarget, threadId: string): Promise<{ conversation: InboxAskConversation | null; running: string | null }> {
  return (await (await fromWindow(target, `/api/inbox/threads/${threadId}/ask`)).json()) as { conversation: InboxAskConversation | null; running: string | null };
}

export async function aiSession(target: AskWindowTarget, providerId: string, threadId: string, title = "Ship it?"): Promise<string> {
  const created = await fromWindow(target, "/api/ai/session", { providerId, context: { mode: "annotate", annotate: { filePath: `Inbox thread "${title}" (${threadId})`, content: "" } } });
  if (created.status !== 200) throw new Error(`POST /api/ai/session answered ${created.status}: ${await created.text()}`);
  return ((await created.json()) as { sessionId: string }).sessionId;
}

/** Not awaited by callers: the headers go out with the first word, and the agent answers only after this returns. */
export function runQuery(target: AskWindowTarget, sessionId: string, question: string, busyPolicy?: "wait" | "interrupt") {
  const browser = new AbortController();
  const messages: AskQueryMessage[] = [];
  const decoder = new TextDecoder();
  const finished = (async () => {
    let text = "";
    try {
      const response = await fromWindow(target, "/api/ai/query", { sessionId, prompt: question, ...(busyPolicy ? { busyPolicy } : {}) }, browser.signal);
      const reader = response.body!.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        text += decoder.decode(value, { stream: true });
        const lines = text.split("\n");
        text = lines.pop()!;
        for (const line of lines) if (line.startsWith("data: {")) messages.push(JSON.parse(line.slice(6)));
      }
    } catch {
      // The browser dropped.
    }
  })();
  return { sessionId, messages, finished, drop: () => browser.abort() };
}
