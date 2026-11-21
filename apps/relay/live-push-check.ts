/**
 * The owner's check after going live (apps/relay/GOING-LIVE.md, step 5): one
 * sealed test push to one paired test phone, through the deployed relay, and
 * only its delivery status read back. Not part of CI; never run by an agent.
 *
 *   bun apps/relay/live-push-check.ts dev_01K7...            the Inbox's data folder as Plannotator finds it
 *   PLANNOTATOR_DATA_DIR=/path bun apps/relay/live-push-check.ts dev_01K7...
 *
 * It reads, on this computer only, the Inbox's mailbox (`inbox/relay.json`)
 * and that phone's pairing secret (`inbox/device-secrets/<id>`), seals the
 * test summary under the phone's device key exactly as the Inbox seals a push,
 * and posts it to the relay the mailbox lives at. It prints the relay's answer
 * (`sent`, `reason`, `code`, Apple's status and reason) and nothing else: no
 * secret, key, envelope or token. Exit 0 when the relay says Apple took it.
 * The phone shows "Plannotator relay check" when its extension opens it.
 */
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveRelayKeys, encryptWithKey } from "../../packages/core/crypto";
import { getPlannotatorDataDir } from "../../packages/shared/data-dir";
import { inboxDir } from "../../packages/shared/inbox/schema";

const deviceId = process.argv[2] ?? "";
if (!/^dev_[A-Za-z0-9]+$/.test(deviceId)) {
  console.error("usage: bun apps/relay/live-push-check.ts <device id>   (Settings, Remote devices, or inbox/devices.jsonl)");
  process.exit(2);
}
const dir = inboxDir(getPlannotatorDataDir());
let mailbox: { url: string; mailbox_id: string; secret: string };
let pairing: string;
try {
  mailbox = JSON.parse(readFileSync(join(dir, "relay.json"), "utf8"));
  pairing = readFileSync(join(dir, "device-secrets", deviceId), "utf8").trim();
} catch {
  console.error(`No mailbox or no pairing secret for ${deviceId} under ${dir}: pair the phone with this Inbox first.`);
  process.exit(2);
}

const { key, collapseKey } = await deriveRelayKeys(pairing, deviceId);
// A thread id no real thread has, so the check never replaces a real notification.
const threadId = `msg_relaycheck${randomBytes(6).toString("hex")}`;
const summary = {
  v: 1,
  type: "push",
  thread_id: threadId,
  message_id: threadId,
  subject: "Plannotator relay check",
  project: "",
  agent: "Plannotator",
  question: null,
  kind: "new_thread",
  badge: 0,
  time_sensitive: false,
};
const answer = await fetch(`${mailbox.url}/v1/mailboxes/${mailbox.mailbox_id}/push`, {
  method: "POST",
  headers: { Authorization: `Bearer ${mailbox.secret}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    device_id: deviceId,
    collapse_id: createHmac("sha256", Buffer.from(collapseKey, "base64url")).update(threadId).digest("hex"),
    ciphertext: await encryptWithKey(JSON.stringify(summary), key),
  }),
  signal: AbortSignal.timeout(15_000),
});
const body = (await answer.json().catch(() => ({}))) as Record<string, unknown>;
const status = { http: answer.status, sent: body.sent ?? false, reason: body.reason ?? null, code: body.code ?? null, apns_status: body.apns_status ?? null, apns_reason: body.apns_reason ?? null };
console.log(JSON.stringify(status));
process.exit(body.sent === true ? 0 : 1);
