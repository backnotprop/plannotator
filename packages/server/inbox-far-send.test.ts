/**
 * A far agent's send_message, run on the thread's own computer (inbox-far-send.ts `farSendMessage`). One real store in
 * a temp folder stands for the thread's computer; no Inbox runs. What regresses: the answer written as a local session
 * (no `machine`), a field the agent gave dropped, its files read from this computer's disk, a session or computer the
 * agent names in its arguments taken over the one its computer's token said, a refusal of the tool lost or renamed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { receiveInboxUpload } from "@plannotator/shared/inbox/uploads";
import { farSendMessage } from "./inbox-far-send";
import type { FarReplyInput } from "./inbox-far-tags";
import type { InboxMcpContext } from "./inbox-mcp";

const LAPTOP = `ibx_01JZ${"0".repeat(20)}A1`;
const OTHER = `ibx_01JZ${"0".repeat(20)}B1`;
const FAR = "ses_far_agent";
const OWNER: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_owner", name: null };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function studio() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-far-send-")));
  roots.push(root);
  const projectRoot = join(root, "api");
  mkdirSync(projectRoot, { recursive: true });
  // A file of this computer's that a far agent's attachment names: it must never be read.
  writeFileSync(join(projectRoot, "notes.md"), "# This computer's notes\n");
  const store = InboxStore.open(join(root, "data"));
  const project = store.ensureProject({ name: "api", root: projectRoot });
  const asked = store.sendMessage({ project_id: project.id, author: OWNER, body: "Should the retry queue keep its order?", wakes: true }).message;
  const base = { store, baseUrl: () => "http://localhost:1/", resolveProject: async () => project } as unknown as InboxMcpContext;
  const send = (args: Record<string, unknown>, extra: Partial<FarReplyInput> = {}) =>
    farSendMessage(base, { machine: LAPTOP, machine_name: "Laptop", session: FAR, host: "claude-code", name: "Builder", args, ...extra });
  return { store, asked, send, projectRoot };
}

const refusal = async (run: Promise<unknown>): Promise<InboxError> => {
  try {
    await run;
  } catch (error) {
    if (error instanceof InboxError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
};

describe("a far agent's send_message on the thread's computer", () => {
  test("writes in the thread as that computer's session, with every field it gave and its uploaded file", async () => {
    const w = studio();
    const at = new Date().toISOString();
    const upload = await receiveInboxUpload(w.store.dir, "trace.txt", new Response("retry trace").body, { at });
    const sent = await w.send({ body: "Keep the order: the consumer depends on it.", reply_to: w.asked.id, idempotency_key: "far-1", attachments: [upload.upload_id], priority: true });
    const id = String(sent.structured.message_id);
    expect(sent.structured.thread_id).toBe(w.asked.thread_id);
    const message = w.store.message(id)!;
    expect(message.thread_id).toBe(w.asked.thread_id);
    expect(message.body).toBe("Keep the order: the consumer depends on it.");
    expect(message.author).toEqual(expect.objectContaining({ kind: "agent", host: "claude-code", session: FAR, name: "Builder", machine: LAPTOP, machine_name: "Laptop" }));
    expect(message.attachments?.map((a) => a.name)).toEqual(["trace.txt"]);
    expect(message.idempotency_key).toBe("far-1");
    // Priority, as a local send marks it: the tool's own answer says the thread is in the person's Priority now.
    expect(sent.structured.priority).toBe(true);
    expect(w.store.thread(w.asked.thread_id)!.messages.map((m) => m.id)).toEqual([w.asked.id, id]);

    // The same key again is the same message, never a second one.
    const again = await w.send({ body: "Keep the order: the consumer depends on it.", reply_to: w.asked.id, idempotency_key: "far-1", attachments: [upload.upload_id], priority: true });
    expect(again.structured.message_id).toBe(id);
    expect(w.store.thread(w.asked.thread_id)!.messages).toHaveLength(2);
  });

  test("the session and computer are the ones its computer's token named, whatever its arguments say", async () => {
    const w = studio();
    const sent = await w.send({ body: "Done.", reply_to: w.asked.id, idempotency_key: "far-2", agent_session: "ses_owner", agent_host: "pi", agent_name: "Owner" });
    const author = w.store.message(String(sent.structured.message_id))!.author;
    expect(author).toEqual(expect.objectContaining({ session: FAR, host: "claude-code", name: "Builder", machine: LAPTOP, machine_name: "Laptop" }));
    // Another computer named in the arguments is no tool field: refused, nothing written.
    const error = await refusal(w.send({ body: "As Mini.", reply_to: w.asked.id, idempotency_key: "far-2b", agent_machine: { id: OTHER, name: "Mini" } }));
    expect(error.code).toBe("validation_error");
    expect(w.store.thread(w.asked.thread_id)!.messages).toHaveLength(2);
  });

  test("a file that is not an upload sent to this computer is refused, and nothing is written", async () => {
    const w = studio();
    for (const attachment of ["notes.md", join(w.projectRoot, "notes.md"), "upl_not_here", 7]) {
      const error = await refusal(w.send({ body: "See the notes.", reply_to: w.asked.id, idempotency_key: `far-file-${String(attachment)}`, attachments: [attachment] }));
      expect(error.code).toBe("validation_error");
      expect(error.details).toEqual({ field: "attachments[0]" });
    }
    expect(w.store.thread(w.asked.thread_id)!.messages).toHaveLength(1);
  });

  test("the tool's own refusal comes back with its code, and nothing is written", async () => {
    const w = studio();
    const error = await refusal(w.send({ body: "", reply_to: w.asked.id, idempotency_key: "far-3" }));
    expect(error.code).not.toBe("internal_error");
    expect(error.message.length).toBeGreaterThan(0);
    expect(w.store.thread(w.asked.thread_id)!.messages).toHaveLength(1);
  });
});
