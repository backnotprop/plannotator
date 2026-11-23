/**
 * The note that tells a session its questions moved (resolve_message's `moved_to`) never starts a cloud agent's run:
 * a run would be worded "the person wrote to you" for a notice that needs nothing. The cloud wake over a real store in
 * a temp data dir, with a fake webhook (no network). A plain reply to the same agent still starts one, so the wake
 * is live in this test.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import type { InboxCloudAgent, InboxCloudAgents } from "./inbox-cloud-agents";
import { createInboxCloudWake, type InboxCloudWaker } from "./inbox-cloud-wake";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
});

const ASK = (prompt: string) => [":::question", prompt, "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");
const CLOUD = "cloud.0123456789ab";

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  expect(check()).toBe(true);
}

test("a moved note waiting for a cloud agent starts no run; a reply to it does", async () => {
  const root = mkdtempSync(join(tmpdir(), "plannotator-cloud-wake-moved-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = InboxStore.open(join(root, "data"));
  const project = store.ensureProject({ name: "billing", root: join(root, "billing") });
  const cloudAuthor: InboxAuthor = { kind: "agent", host: "cloud", session: CLOUD, name: "Night bot" };
  const orch: InboxAuthor = { kind: "agent", host: "claude-code", session: "ses_orch", name: null };
  const old = store.sendMessage({ project_id: project.id, author: cloudAuthor, subject: "Retry policy", body: ASK("Retry failed charges?") }).message;
  const brief = store.sendMessage({ project_id: project.id, author: orch, subject: "Morning brief", body: ASK("Retry failed charges?") }).message;
  store.resolveThread(old.id, true, "agent", { to: brief.id, session: "ses_orch" });
  expect(store.pendingReplies(CLOUD).map((m) => !!m.moved_note)).toEqual([true]);

  const agent: InboxCloudAgent = {
    session: CLOUD,
    name: "Night bot",
    preset: "other",
    url: "https://hooks.example.invalid/wake",
    key: "test-key",
    project_id: project.id,
    created_at: "2026-11-21T00:00:00.000Z",
    key_set_at: "2026-11-21T00:00:00.000Z",
    key_rejected_at: null,
  };
  const agents = { list: () => [agent], agent: (session: string) => (session === CLOUD ? agent : null), homeRoot: () => null, markKeyRejected: () => {} } as unknown as InboxCloudAgents;
  const posted: string[] = [];
  const fakeFetch = (async (_url: string, init: { body: string }) => {
    posted.push(init.body);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const wake: InboxCloudWaker = createInboxCloudWake({ store, agents, pin: () => {}, threadUrl: (id) => `http://127.0.0.1:1/#thread=${id}`, fetch: fakeFetch, gapMs: 0, log: () => {} });
  cleanup.push(() => wake.stop());
  await wake.sweep();
  await Bun.sleep(30);
  expect(posted).toEqual([]);
  expect(store.message(store.pendingReplies(CLOUD)[0]!.id)!.cloud_wake ?? null).toBeNull();

  // The same agent's question elsewhere, answered: that reply starts a run, and the note still rides none.
  const other = store.sendMessage({ project_id: project.id, author: cloudAuthor, subject: "Logs", body: "Logs are in." }).message;
  store.sendReply(other.id, { idempotency_key: "k-logs", words: "Thanks." });
  await until(() => posted.length === 1);
  expect(posted[0]).toContain("Thanks.");
  expect(posted[0]).not.toContain("were moved to another thread");
});
