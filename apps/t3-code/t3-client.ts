import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import * as z from "zod";

export function t3Endpoint(value: string): URL {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("T3 requires HTTPS, or HTTP on loopback for a local environment.");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/mcp") {
    throw new Error("Use the MCP URL from T3 Settings → Connections, ending in /mcp without credentials or query parameters.");
  }
  return url;
}

const timelineItem = z.object({
  position: z.number().int().nonnegative(),
  itemId: z.string(),
  messageId: z.string().nullable(),
  runId: z.string().nullable(),
  sourceThreadId: z.string(),
  type: z.string(),
  visibility: z.enum(["local", "inherited", "synthetic"]).optional(),
  status: z.string(),
  text: z.string().nullable(),
  textTruncated: z.boolean(),
  nextTextOffset: z.number().nullable().optional(),
}).passthrough();

const threadRead = z.object({
  thread: z.object({
    threadId: z.string(),
    projectId: z.string(),
    status: z.string(),
    activeRunId: z.string().nullable(),
    latestRunId: z.string().nullable(),
    itemCount: z.number().int().nonnegative(),
    worktreePath: z.string().nullable(),
    archived: z.boolean(),
    pendingRequestCount: z.number(),
  }).passthrough(),
  recentRuns: z.array(z.object({ runId: z.string(), status: z.string(), startedAt: z.string().nullable() }).passthrough()),
  items: z.array(timelineItem),
  nextPosition: z.number().nullable(),
  hasMore: z.boolean(),
});

const sentMessage = z.object({
  threadId: z.string(), messageId: z.string(), runId: z.string(), status: z.string(),
  delivery: z.enum(["started", "queued", "steered", "restarted"]),
});

export type T3ThreadRead = z.infer<typeof threadRead>;
export type T3TimelineItem = z.infer<typeof timelineItem>;
export type T3SentMessage = z.infer<typeof sentMessage>;

export interface T3Rpc {
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export class T3Client implements T3Rpc {
  constructor(readonly client: Client) {}

  static async connect(url: URL, token: () => string | undefined): Promise<T3Client> {
    const client = new Client({ name: "plannotator-t3", version: "0.0.1" });
    const accessToken = token();
    try {
      await client.connect(new StreamableHTTPClientTransport(url, { authProvider: { token: async () => accessToken } }));
      return new T3Client(client);
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const result = await this.client.callTool({ name, arguments: args }, { signal, timeout: 60_000 });
    const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    if (result.isError) throw new Error(`T3 ${name}: ${text || "request refused"}`);
    if (result.structuredContent) return result.structuredContent;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`T3 ${name} returned an incompatible response.`);
    }
  }

  close(): Promise<void> { return this.client.close(); }
}

export class T3Thread {
  constructor(readonly rpc: T3Rpc, readonly id: string) {
    if (!id.trim() || id.length > 256 || /[\s\u0000-\u001f]/.test(id)) throw new Error("An explicit T3 thread ID is required.");
  }

  async read(args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T3ThreadRead> {
    const result = threadRead.parse(await this.rpc.call("t3_thread_read", { view: "messages", limit: 100, runLimit: 50, maxCharsPerItem: 50_000, ...args, threadId: this.id }, signal));
    if (result.thread.threadId !== this.id) throw new Error("T3 returned a different thread; the connection was refused.");
    return result;
  }

  async send(text: string, requestId: string, signal?: AbortSignal): Promise<T3SentMessage> {
    if (!text.trim() || text.length > 120_000) throw new Error("T3 messages must contain 1–120,000 characters.");
    const result = sentMessage.parse(await this.rpc.call("t3_thread_send", { threadId: this.id, message: text, mode: "queue", clientRequestId: requestId }, signal));
    if (result.threadId !== this.id || result.delivery === "steered" || result.delivery === "restarted") throw new Error("T3 did not queue the message into the selected thread.");
    return result;
  }

  async runStatus(runId: string, signal?: AbortSignal): Promise<string> {
    const result = z.object({ threadId: z.string(), runId: z.string().nullable(), status: z.string() }).parse(
      await this.rpc.call("t3_thread_wait", { threadId: this.id, runId, timeoutMs: 0 }, signal));
    if (result.threadId !== this.id || result.runId !== runId) throw new Error("T3 returned a different question run.");
    return result.status;
  }

  async itemsAfter(position: number | undefined, signal?: AbortSignal): Promise<T3ThreadRead> {
    let page = await this.read(position === undefined ? {} : { afterPosition: position }, signal);
    const result = { ...page, items: [...page.items] };
    for (let count = 0; page.hasMore; count++) {
      if (count >= 100 || page.nextPosition === null) throw new Error("T3 timeline pagination did not settle.");
      const cursor = page.nextPosition;
      page = await this.read({ afterPosition: cursor }, signal);
      if (page.hasMore && page.nextPosition === cursor) throw new Error("T3 timeline cursor did not advance.");
      result.items.push(...page.items);
    }
    return result;
  }

  async fullText(item: T3TimelineItem, signal?: AbortSignal): Promise<string> {
    let text = item.text ?? "";
    let current = item;
    while (current.textTruncated) {
      if (current.nextTextOffset == null || text.length > 2_000_000) throw new Error("T3 answer exceeds the supported read limit.");
      const offset = current.nextTextOffset;
      const page = await this.read({ itemId: item.itemId, textOffset: offset }, signal);
      const next = page.items.find((part) => part.itemId === item.itemId);
      if (!next || (next.textTruncated && (next.nextTextOffset == null || next.nextTextOffset <= offset))) throw new Error("T3 truncated answer cursor did not advance.");
      text += next.text ?? "";
      current = next;
    }
    return text;
  }
}

export const T3_TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);

export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener("abort", abort); resolve(); }
    function abort() { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason); }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
