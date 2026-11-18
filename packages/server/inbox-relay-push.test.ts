/**
 * The relay push for replaced questions: pushes collapse per thread, so a
 * message that supersedes questions always pushes, even when it asks nothing
 * new (a withdrawal: `question: null`, no lock-screen answers), to replace the
 * older notification; and the summary only ever offers an open question.
 * Push version 2: the kinds the window notifies for (a new thread, a
 * permission prompt, a failed turn), the badge, `time_sensitive`, the
 * actions, no push for a snoozed thread, and the size ladder.
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
import { apnsBody, sizedPushEnvelope, type InboxPushPlaintext } from "./inbox-relay-push";

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
  /** Every push sent so far, opened. */
  const opened = async () => Promise.all(pushes.map(async (push) => JSON.parse(await decryptWithKey(push.ciphertext, keys.key)) as Record<string, any>));
  return { store, project, pushes, nextPush, collapseOf, opened, keys };
}

const PERM_AUTHOR = { kind: "agent" as const, host: "claude-code", session: "perm:ses_a", name: null };
const PERMISSION = [
  "in `/work/billing-svc`",
  "",
  ":::question",
  "Claude Code wants to run `rm -rf build`",
  "",
  "- [ ] Allow once",
  "- [ ] Deny",
  "- [ ] Allow and switch to Auto mode",
  "- [ ] Allow and switch to Full permissions",
  "- [ ] Approve in Terminal",
  ":::",
].join("\n");

test("push 2: a new thread that asks nothing, a failed turn and a permission prompt each push with their kind; plain news does not", async () => {
  const w = await world();
  const root = w.store.sendMessage({ project_id: w.project.id, author: AGENT, subject: "Migrated the ledger", body: "Done, nothing to decide." }).message;
  const fresh = await w.nextPush(0);
  expect(fresh.summary).toMatchObject({ kind: "new_thread", thread_id: root.id, question: null, time_sensitive: false });
  expect(fresh.summary.actions).toBeUndefined();

  w.store.sendMessage({ project_id: w.project.id, author: AGENT, body: "A plain note.", reply_to: root.id });
  w.store.sendMessage({ project_id: w.project.id, author: AGENT, body: "The turn failed: rate limited.", reply_to: root.id, turn_error: true });
  const failed = await w.nextPush(1);
  expect(w.pushes.length).toBe(2);
  expect(failed.summary).toMatchObject({ kind: "turn_error", thread_id: root.id, question: null });

  const perm = w.store.sendMessage({ project_id: w.project.id, author: PERM_AUTHOR, permission: true, body: PERMISSION, reply_to: root.id }).message;
  const asked = await w.nextPush(2);
  expect(asked.summary.kind).toBe("permission");
  expect(asked.summary.message_id).toBe(perm.id);
  expect(asked.summary.time_sensitive).toBe(true);
  // Only what one tap can answer: no mode switch (Full asks to confirm first), no hand-off to Terminal.
  expect(asked.summary.question.choices.map((c: { label: string }) => c.label)).toEqual(["Allow once", "Deny"]);
  expect(asked.summary.actions).toEqual([
    { id: "choice.0", label: "Allow once" },
    { id: "choice.1", label: "Deny" },
  ]);
  expect(asked.collapse_id).toBe(w.collapseOf(root.id));
});

test("push 2: actions name each choice by its index, recommended first; an action item gets none; a held-up thread is time sensitive", async () => {
  const w = await world();
  const body = [":::question", "Which retry policy?", "", "Stopped: the deploy waits on this", "", "Recommended: Exponential", "", "- [ ] Fixed", "- [ ] Exponential", ":::"].join("\n");
  w.store.sendMessage({ project_id: w.project.id, author: AGENT, body });
  const asked = await w.nextPush(0);
  expect(asked.summary.kind).toBe("question");
  expect(asked.summary.time_sensitive).toBe(true);
  expect(asked.summary.actions).toEqual([
    { id: "choice.1", label: "Exponential" },
    { id: "choice.0", label: "Fixed" },
  ]);
  w.store.sendMessage({ project_id: w.project.id, author: AGENT, body: ":::action\nRotate the staging key\n:::" });
  const item = await w.nextPush(1);
  expect(item.summary.kind).toBe("question");
  expect(item.summary.question).toBeNull();
  expect(item.summary.actions).toBeUndefined();
});

test("push 2: the badge counts the rows waiting on the person, a snoozed thread neither pushes nor counts, and pushes again once back", async () => {
  const w = await world();
  const first = w.store.sendMessage({ project_id: w.project.id, author: AGENT, body: QUESTION("Retry a 409?") }).message;
  expect((await w.nextPush(0)).summary.badge).toBe(1);
  w.store.sendMessage({ project_id: w.project.id, author: AGENT, body: QUESTION("Bump the SDK?") });
  expect((await w.nextPush(1)).summary.badge).toBe(2);

  w.store.setSnooze(first.thread_id, new Date(Date.now() + 3_600_000).toISOString());
  w.store.sendMessage({ project_id: w.project.id, author: AGENT, body: QUESTION("And a 429?"), reply_to: first.id });
  w.store.sendMessage({ project_id: w.project.id, author: AGENT, body: "The turn failed.", reply_to: first.id, turn_error: true });
  w.store.sendMessage({ project_id: w.project.id, author: AGENT, body: QUESTION("Pin the Node version?") });
  const third = await w.nextPush(2);
  // The snoozed thread's question and failed turn sent nothing, and it is not in the count.
  expect(w.pushes.length).toBe(3);
  expect(third.summary.question.prompt).toBe("Pin the Node version?");
  expect(third.summary.badge).toBe(2);

  w.store.endSnooze(first.thread_id);
  w.store.sendMessage({ project_id: w.project.id, author: AGENT, body: QUESTION("Still retry a 409?"), reply_to: first.id });
  const back = await w.nextPush(3);
  expect(back.summary.thread_id).toBe(first.thread_id);
  expect(back.summary.badge).toBe(3);
});

const LADDER_BASE: InboxPushPlaintext = {
  v: 1,
  type: "push",
  thread_id: "msg_01K70000000000000000000010",
  message_id: "msg_01K70000000000000000000010",
  subject: "Run the retry tests?",
  project: "billing-svc",
  agent: "Claude Code",
  kind: "question",
  badge: 3,
  time_sensitive: true,
  question: { key: "q-1", revision: 0, prompt: "Run them?", context: "Four minutes.", choices: [{ label: "Yes", recommended: true }, { label: "No", recommended: false }] },
  actions: [{ id: "choice.0", label: "Yes" }, { id: "choice.1", label: "No" }],
};

const fits = (envelope: string) => Buffer.byteLength(apnsBody(envelope)) <= 4096;

test("push 2's ladder keeps Apple's 4096 bytes: action labels go first, then the context, then the question, then all but the ids, kind and badge", async () => {
  const key = Buffer.alloc(32, 7).toString("base64url");
  const open = async (summary: InboxPushPlaintext) => {
    const envelope = await sizedPushEnvelope(summary, key);
    expect(fits(envelope)).toBe(true);
    return JSON.parse(await decryptWithKey(envelope, key)) as InboxPushPlaintext;
  };
  expect(await open(LADDER_BASE)).toEqual(LADDER_BASE);

  // Long labels: the actions lose their labels, the question keeps its choices.
  const long = "L".repeat(800);
  const labelled: InboxPushPlaintext = { ...LADDER_BASE, question: { ...LADDER_BASE.question!, choices: [{ label: long, recommended: true }, { label: `${long}2`, recommended: false }] }, actions: [{ id: "choice.0", label: long }, { id: "choice.1", label: `${long}2` }] };
  const noLabels = await open(labelled);
  expect(noLabels.actions).toEqual([{ id: "choice.0" }, { id: "choice.1" }]);
  expect(noLabels.question?.context).toBe("Four minutes.");

  const wordy: InboxPushPlaintext = { ...labelled, question: { ...labelled.question!, context: "C".repeat(1200) } };
  const noContext = await open(wordy);
  expect(noContext.question?.context).toBeNull();
  expect(noContext.actions).toEqual([{ id: "choice.0" }, { id: "choice.1" }]);

  const huge: InboxPushPlaintext = { ...wordy, question: { ...wordy.question!, prompt: "P".repeat(3000) } };
  const noQuestion = await open(huge);
  expect(noQuestion.question).toBeNull();
  expect(noQuestion.actions).toBeUndefined();
  expect(noQuestion.subject).toBe("Run the retry tests?");

  const idsOnly = await open({ ...huge, subject: "S".repeat(4000) });
  expect(idsOnly).toEqual({ v: 1, type: "push", thread_id: LADDER_BASE.thread_id, message_id: LADDER_BASE.message_id, kind: "question", badge: 3, time_sensitive: true });
});

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
  expect(withdrawn.summary.kind).toBe("replaced");
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
