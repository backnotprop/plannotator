/**
 * A far agent's send_message, run on the thread's own computer (inbox-far-tags.ts `agentReply`): the same tool a local
 * agent calls, with every field it takes (files, steps, PRs, a branch report, Priority, a thread name), so the
 * message, its checks, its refusals and its answer are a local send's. What differs is only where things are:
 *
 * - The author is that computer's session (`farAuthor`: its message carries `machine` and `machine_name`).
 * - Its files came as uploads (its computer read them from its own disk and sent the bytes to this door's `uploads`
 *   route, as a window's reply on another computer sends its files): each attachment is an upload id here, and a picture
 *   the body shows by a file's name shows that upload (inbox-cloud-pictures.ts). Nothing is read from this disk.
 * - A branch report names its head (its computer read it from its own git), as a cloud agent's does.
 * - The session is woken by its own computer, so its next step reads as one a reply wakes.
 */

import { createMcpHandler } from "@modelcontextprotocol/server";
import { inboxBlobPath } from "@plannotator/shared/inbox/attachments";
import { INBOX_MAX_REQUEST_BYTES, mcpAnswerOfResponse } from "@plannotator/shared/inbox/connection";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { inboxUploadAttachments, readInboxUpload } from "@plannotator/shared/inbox/uploads";
import type { InboxSendUpload } from "./inbox-cloud-pictures";
import type { FarReplyInput } from "./inbox-far-tags";
import { createInboxMcpServer, type InboxMcpContext } from "./inbox-mcp";

/** A folder no project has: a far branch report never files under a project by a folder of this computer. */
const FAR_HOME = "\u0000far";

export async function farSendMessage(base: InboxMcpContext, input: FarReplyInput): Promise<{ text: string; structured: Record<string, unknown> }> {
  const { store } = base;
  const files = Array.isArray(input.args.attachments) ? input.args.attachments : [];
  const uploads: InboxSendUpload[] = files.map((id, i) => {
    const upload = typeof id === "string" ? readInboxUpload(store.dir, id) : null;
    if (!upload) throw new InboxError("validation_error", `attachments[${i}]: not a file sent to this computer.`, { field: `attachments[${i}]` });
    return { id: id as string, name: upload.name, kind: upload.kind, path: inboxBlobPath(store.dir, upload.sha256) };
  });
  const sent = new Set(uploads.map((upload) => upload.id));
  const context: InboxMcpContext = {
    ...base,
    farAuthor: { id: input.machine, name: input.machine_name },
    cloudAgent: { homeRoot: FAR_HOME },
    inlineImageFiles: uploads,
    recordAttachments: async (items) => {
      if (!items.every((item) => typeof item === "string" && sent.has(item))) throw new InboxError("validation_error", "attachments: each one a file sent to this computer.");
      return inboxUploadAttachments(store.dir, items as string[], new Date(base.now?.() ?? Date.now()).toISOString());
    },
    sessionWakes: async () => true,
  };
  const args = { ...input.args, agent_session: input.session, ...(input.host ? { agent_host: input.host } : {}), ...(input.name ? { agent_name: input.name } : {}) };
  const handler = createMcpHandler(() => createInboxMcpServer(context), { legacy: "stateless", maxRequestBodySize: INBOX_MAX_REQUEST_BYTES });
  const response = await handler.fetch(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: args } }),
    }),
  );
  const answer = mcpAnswerOfResponse(response.status, await response.text());
  const result = answer?.result as { isError?: boolean; content?: { text?: string }[]; structuredContent?: Record<string, unknown> } | undefined;
  if (!result) throw new InboxError("internal_error", answer?.error?.message ?? "send_message did not answer.");
  const text = (result.content ?? []).map((part) => part.text ?? "").join("\n");
  if (result.isError) {
    const refusal = /^([a-z][a-z0-9_]*): ([\s\S]*)$/.exec(text);
    throw new InboxError(refusal?.[1] ?? "validation_error", refusal?.[2] ?? text);
  }
  return { text, structured: result.structuredContent ?? {} };
}
