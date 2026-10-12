/**
 * The relay push for replaced questions: pushes collapse per thread, so a
 * message that supersedes questions always pushes, even when it asks nothing
 * new (a withdrawal: `question: null`, no lock-screen answers), to replace the
 * older notification; and the summary only ever offers an open question.
 * A local fake relay records each `POST …/push`; the envelope is opened with
 * the phone's own key, as the phone does. No network beyond loopback.
 */
import { afterEach, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptWithKey, deriveRelayKeys } from "@plannotator/core/crypto";
import { InboxDevices } from "@plannotator/shared/inbox/devices";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxRelay } from "./inbox-relay";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const run of cleanup.splice(0).reverse()) run();
});

const AGENT = { kind: "agent" as const, host: "claude-code", session: "ses_a", name: null };
const QUESTION = (prompt: string, replaces?: string) =>
  [":::question", ...(replaces ? [`Replaces: ${replaces}`] : []), prompt, "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");

async function world() {
  const dataDir = mkdtempSync(join(tmpdir(), "plannotator-inbox-relay-push-"));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const pushes: { collapse_id: string; ciphertext: string }[] = [];
  const relay = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === "POST" && path === "/v1/mailboxes") return Response.json({ mailbox_id: "mbx_test" }, { status: 201 });
      if (req.method === "POST" && path.endsWith("/push")) {
        pushes.push((await req.json()) as { collapse_id: string; ciphertext: string });
        return Response.json({});
      }
      if (req.method === "PUT") return Response.json({});
      return new Response("not here", { status: 404 });
    },
  });
  cleanup.push(() => relay.stop(true));
  const store = InboxStore.open(dataDir);
  const devices = InboxDevices.open(dataDir);
  const secret = randomBytes(32).toString("base64url");
  const device = devices.add({ id: "dev_01M4H6G73M9H3Z32T859E72DPY", name: "Phone", platform: "ios", token: "tok_x", secret, at: new Date().toISOString() });
  const client = createInboxRelay({
    dataDir,
    store,
    devices,
    payload: () => ({}),
    apply: async () => new Response(null, { status: 404 }),
    url: `http://127.0.0.1:${relay.port}`,
    log: () => {},
  });
  expect(await client.paired(device)).not.toBeNull();
  client.start();
  cleanup.push(() => client.stop());
  const keys = await deriveRelayKeys(secret, device.id);
  const project = store.ensureProject({ name: "billing-svc", root: "/work/billing-svc" });
  /** The next push, opened with the phone's key. */
  const nextPush = async (after: number) => {
    for (let i = 0; i < 200 && pushes.length <= after; i++) await Bun.sleep(10);
    const push = pushes[after];
    if (!push) throw new Error("no push");
    return { collapse_id: push.collapse_id, summary: JSON.parse(await decryptWithKey(push.ciphertext, keys.key)) as Record<string, any> };
  };
  const collapseOf = (threadId: string) => createHmac("sha256", Buffer.from(keys.collapseKey, "base64url")).update(threadId).digest("hex");
  return { store, project, pushes, nextPush, collapseOf };
}

test("a withdrawal that asks nothing pushes on the thread's collapse id with no question; plain news still does not", async () => {
  const w = await world();
  const first = w.store.sendMessage({ project_id: w.project.id, author: AGENT, body: QUESTION("Retry a 409?") }).message;
  const asked = await w.nextPush(0);
  expect(asked.summary.question?.prompt).toBe("Retry a 409?");
  w.store.sendMessage({ project_id: w.project.id, author: AGENT, body: "Just a note.", reply_to: first.id });
  w.store.sendMessage({ project_id: w.project.id, author: AGENT, body: "No longer needed.", reply_to: first.id, supersedes: [first.id] });
  const withdrawn = await w.nextPush(1);
  // The note sent no push: the withdrawal is the second one.
  expect(w.pushes.length).toBe(2);
  expect(withdrawn.collapse_id).toBe(asked.collapse_id);
  expect(withdrawn.collapse_id).toBe(w.collapseOf(first.thread_id));
  expect(withdrawn.summary.type).toBe("push");
  expect(withdrawn.summary.thread_id).toBe(first.thread_id);
  expect(withdrawn.summary.question).toBeNull();
});

test("a replacement pushes the new open question on the same collapse id", async () => {
  const w = await world();
  const first = w.store.sendMessage({ project_id: w.project.id, author: AGENT, body: QUESTION("Retry a 409?") }).message;
  const asked = await w.nextPush(0);
  const key = first.questions![0]!.key;
  const second = w.store.sendMessage({ project_id: w.project.id, author: AGENT, body: QUESTION("How many retries before dead-letter?", `${first.id}/${key}`), reply_to: first.id }).message;
  const replaced = await w.nextPush(1);
  expect(replaced.collapse_id).toBe(asked.collapse_id);
  expect(replaced.summary.message_id).toBe(second.id);
  expect(replaced.summary.question).toMatchObject({ key: second.questions![0]!.key, prompt: "How many retries before dead-letter?" });
  expect(replaced.summary.subject).toBe("How many retries before dead-letter?");
});

// A thread that came back from the archive: the agent's reply_to after the
// archive line asks a question the person can answer without unarchiving, so
// the push offers it on the lock screen; the archive-closed question never is.
test("a question asked after the archive line is pushed answerable; the archive-closed one is not offered", async () => {
  const w = await world();
  const first = w.store.sendMessage({ project_id: w.project.id, author: AGENT, body: QUESTION("Retry a 409?") }).message;
  await w.nextPush(0);
  w.store.resolveThread(first.id, true);
  const later = w.store.sendMessage({ project_id: w.project.id, author: AGENT, body: QUESTION("Ship it today?"), reply_to: first.id }).message;
  const pushed = await w.nextPush(1);
  expect(pushed.summary.message_id).toBe(later.id);
  expect(pushed.summary.question).toMatchObject({ prompt: "Ship it today?", key: later.questions![0]!.key });
  // The lock-screen answer goes through: the message is answerable while the thread stays resolved.
  const q = w.store.questionsOf(later.id)[0]!;
  w.store.savePicks(later.id, [{ key: q.key, revision: 0, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: ["Yes"] } }]);
  expect(w.store.questionsOf(later.id)[0]!.state).toBe("picked");
  expect(w.store.questionsOf(first.id)[0]!.state).toBe("closed");
  expect(w.store.message(first.id)!.resolved_at).not.toBeNull();
});
