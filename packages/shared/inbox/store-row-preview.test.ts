/**
 * A list row's grey line is the thread's latest message (approval "inbox-row-latest-preview"), worked out by the
 * store on a real store in a temp dir. Failures to catch: an older message shown while a newer agent message is
 * unread; the Inbox's own reply (an action item's report) shown over agent news the person has not read; the
 * person's reply missing its "You: "; a question, an answer or a files-only message shown as raw markdown or as
 * nothing; an unnamed thread repeating its own title; a line that grows with the body.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxId, type InboxAuthor, type InboxQuestion } from "@plannotator/core/inbox-types";
import type { InboxAttachment } from "@plannotator/core/inbox-attachments";
import { INBOX_ROW_PREVIEW_MAX } from "@plannotator/core/inbox-row-preview";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };

function open() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-row-preview-"));
  roots.push(dir);
  const clock = { now: Date.parse("2026-11-09T10:00:00.000Z") };
  const store = InboxStore.open(dir, { now: () => new Date((clock.now += 1000)) });
  const project = store.ensureProject({ name: "web", root: "/work/web" });
  const send = (body: string, extra: { thread?: string; reply_to?: string; subject?: string; attachments?: InboxAttachment[] } = {}) =>
    store.sendMessage({ project_id: project.id, author: AGENT, body, ...extra }).message;
  const row = (threadId: string) => store.listRows().find((r) => r.thread_id === threadId)!;
  return { store, clock, send, row };
}

const ASK = ["Release notes are drafted.", "", ":::question", "Ship **today**, or wait for the Windows fix?", "", "- [ ] Ship today", "- [ ] Wait for the fix", ":::"].join("\n");

const pick = (q: InboxQuestion, label: string) => ({ key: q.key, revision: q.revision, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [label] } });

function file(name: string): InboxAttachment {
  return { id: inboxId("att"), path: `/work/web/${name}`, named_path: null, name, kind: "markdown", sent_sha256: "0".repeat(64), size: 10, sent_at: new Date().toISOString(), sent_mtime: new Date().toISOString() } as InboxAttachment;
}

describe("which message the line shows", () => {
  test("the newest message, and the person's own reply as You: …", () => {
    const { store, send, row } = open();
    const root = send("Migration plan for the billing tables.", { thread: "billing" });
    expect(row(root.thread_id).latest_preview).toBe("Migration plan for the billing tables.");
    store.sendReply(root.id, { words: "Go with option **B** and keep the old column for a week.", idempotency_key: "k-1" });
    expect(row(root.thread_id).latest_preview).toBe("You: Go with option B and keep the old column for a week.");
    const next = send("Done: option B is in.", { reply_to: root.id });
    expect(row(root.thread_id).latest_preview).toBe("Done: option B is in.");
    void next;
  });

  test("while an agent message is unread it wins over the Inbox's reply written after it", () => {
    const { store, clock, send, row } = open();
    const root = send(["Release 4.2 is built.", "", ":::action", "Approve the production deploy", ":::"].join("\n"), { thread: "release" });
    store.markSeen(root.thread_id);
    const action = store.questionsOf(root.id).find((q) => q.kind === "action")!;
    store.markAction(root.id, action.key, { outcome: "done" });
    // Agent news lands inside the Undo window, then the Inbox writes the person's report after it.
    send("Pagefind index built: 1.2 MB for 340 pages.", { reply_to: root.id });
    clock.now += 60_000;
    const [report] = store.settleActions(10_000);
    expect(report).toBeDefined();
    const shown = row(root.thread_id);
    expect(shown.unseen).toBe(1);
    expect(shown.latest_preview).toBe("Pagefind index built: 1.2 MB for 340 pages.");
    // Once read, the newest message is the report: the person's own words.
    store.markSeen(root.thread_id);
    expect(row(root.thread_id).latest_preview).toStartWith("You: ");
  });

  test("an unnamed thread gets no line for its first message (its title says it), and one for a reply", () => {
    const { store, send, row } = open();
    const root = send("Can I delete the old fixtures folder?");
    expect(row(root.thread_id).latest_preview).toBeNull();
    store.sendReply(root.id, { words: "Yes, delete it.", idempotency_key: "k-1" });
    expect(row(root.thread_id).latest_preview).toBe("You: Yes, delete it.");
  });

  test("a named thread's first message gets the line", () => {
    const { send, row } = open();
    const root = send("Pagefind or Algolia for docs search? Pagefind is smaller.", { thread: "search-index", subject: "Docs search" });
    expect(row(root.thread_id).latest_preview).toBe("Pagefind or Algolia for docs search? Pagefind is smaller.");
  });
});

describe("what the line says", () => {
  test("a question: Asked: and its prompt, plain; the person's answer: You answered: and the pick", () => {
    const { store, send, row } = open();
    const root = send("Release notes draft for 0.24.", { thread: "release-0.24" });
    const asked = send(ASK, { reply_to: root.id });
    expect(row(root.thread_id).latest_preview).toBe("Asked: Ship today, or wait for the Windows fix?");
    const q = store.questionsOf(asked.id)[0]!;
    store.sendReply(asked.id, { questions: [pick(q, "Wait for the fix")], idempotency_key: "k-1" });
    expect(row(root.thread_id).latest_preview).toBe("You answered: Wait for the fix");
  });

  test("a skipped question says so", () => {
    const { store, send, row } = open();
    const asked = send(ASK, { thread: "release" });
    const q = store.questionsOf(asked.id)[0]!;
    store.sendReply(asked.id, { questions: [{ key: q.key, revision: q.revision, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [], skipped: true } }], idempotency_key: "k-1" });
    expect(row(asked.thread_id).latest_preview).toBe("You skipped 1 question");
  });

  test("files only: how many and their names", () => {
    const { send, row } = open();
    const root = send("Flaky checkout test on WebKit.", { thread: "checkout" });
    send("![](trace.png)", { reply_to: root.id, attachments: [file("checkout-trace.zip"), file("checkout.png")] });
    expect(row(root.thread_id).latest_preview).toBe("2 files: checkout-trace.zip, checkout.png");
  });

  test("markdown, code fences and links come out as plain words", () => {
    const { send, row } = open();
    const root = send(["# Index built", "", "```sh", "pagefind --site dist", "```", "", "See [the report](https://example.com/r) for **1.2 MB** over `340` pages."].join("\n"), { thread: "search" });
    expect(row(root.thread_id).latest_preview).toBe("Index built See the report for 1.2 MB over 340 pages.");
  });

  test("a long message is cut near the bound, whatever its size", () => {
    const { send, row } = open();
    const root = send(`${"word ".repeat(5000)}end.`, { thread: "long" });
    const line = row(root.thread_id).latest_preview!;
    expect(line.length).toBeLessThanOrEqual(INBOX_ROW_PREVIEW_MAX + 1);
    expect(line.endsWith("…")).toBe(true);
  });
});
