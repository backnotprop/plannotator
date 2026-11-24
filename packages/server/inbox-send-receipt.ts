import { createHash } from "node:crypto";
import { isInboxId } from "@plannotator/core/inbox-types";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { z } from "zod";

export const SEND_RECEIPT_ROUTE = "agent-send-receipt";
const projectId = z.string().refine((id) => isInboxId("prj", id));
const messageId = z.string().refine((id) => isInboxId("msg", id));
export const sendReceiptInput = z.strictObject({
  source: z.string().refine((id) => isInboxId("ibx", id)),
  project_id: projectId,
  idempotency_key: z.string().min(1).refine((key) => key.trim().length > 0),
});
const peerReceiptInput = sendReceiptInput.extend({ session: z.string().min(1), host: z.string().min(1) });
export const sendReceiptAnswer = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("found"), source: z.string(), project_id: projectId, thread_id: messageId, message_id: messageId, questions: z.array(z.strictObject({ key: z.string().min(1) })) }),
  z.strictObject({ status: z.literal("not_found"), source: z.string() }),
  z.strictObject({ status: z.literal("unavailable"), source: z.string() }),
]);
export type SendReceiptInput = z.infer<typeof sendReceiptInput>;
export type SendReceiptAnswer = z.infer<typeof sendReceiptAnswer>;
export type SendReceiptSender = { session: string; host: string };

export function farSendStoredKey(session: string, key: string): string {
  return `far:${createHash("sha256").update([session, key.trim()].join("\u0000")).digest("hex").slice(0, 40)}`;
}

export function readSendReceipt(store: InboxStore, input: SendReceiptInput, sender: SendReceiptSender, machine: string | null): SendReceiptAnswer {
  const key = machine ? farSendStoredKey(sender.session, input.idempotency_key) : input.idempotency_key;
  const receipt = store.agentSendReceipt(input.project_id, key, { ...sender, machine });
  return receipt ? { status: "found", source: input.source, ...receipt } : { status: "not_found", source: input.source };
}

export function peerSendReceipt(store: InboxStore, ownSource: string, machine: string, url: URL): Response {
  const input = peerReceiptInput.safeParse(Object.fromEntries(url.searchParams));
  if (!input.success || input.data.source !== ownSource) return Response.json({ error: "Receipt destination or request is invalid." }, { status: 400 });
  const { host, session, ...ask } = input.data;
  return Response.json(readSendReceipt(store, ask, { host, session }, machine), { headers: { "Cache-Control": "no-store" } });
}
