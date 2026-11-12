import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { inboxRowArchived } from "./list";
import { InboxError } from "./schema";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function open(dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-archived-store-"))) {
  if (!roots.includes(dir)) roots.push(dir);
  return { store: InboxStore.open(dir), dir };
}

const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };
const ASK = (prompt: string, stopped = false) =>
  ["One more call.", "", ":::question", prompt, "", ...(stopped ? ["Stopped: the release waits on this.", ""] : []), "- [ ] Yes", "- [ ] No", ":::"].join("\n");

function cameBack(store: InboxStore, reply = ASK("Ship it today?", true)) {
  const project = store.ensureProject({ name: "billing", root: "/work/billing" });
  const root = store.sendMessage({ project_id: project.id, author: AGENT, body: ASK("Which layout?") }).message;
  store.markSeen(root.id);
  store.resolveThread(root.id, true);
  store.markSeen(root.id);
  const after = store.sendMessage({ project_id: project.id, author: AGENT, body: reply, reply_to: root.id }).message;
  return { project, root, after };
}

const yes = (q: { key: string; kind: string; prompt: string }) => ({ v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: ["Yes"] }) as never;

describe("a thread that came back from the archive", () => {
  test("is back in the list as its reply asks; the archive-closed question stays closed; it stays resolved; replay equals live", () => {
    const { store, dir } = open();
    const { root, after } = cameBack(store);
    const row = store.listRow(root.id)!;
    expect(row.resolved_at).not.toBeNull();
    expect(row).toMatchObject({ agent_after_archive: true, back_from_archive: true, section: "stopped", unread: true });
    expect(inboxRowArchived(row)).toBe(false);
    expect(store.questionsOf(root.id)[0]!.state).toBe("closed");
    expect(store.questionsOf(after.id)[0]!.state).toBe("open");
    expect(store.messageAnswerable(after.id)).toBe(true);
    expect(store.messageAnswerable(root.id)).toBe(false);
    const record = store.questionRecord(`${after.id}/${store.questionsOf(after.id)[0]!.key}`)!;
    expect(store.questionWire(record).state).toBe("open");
    const replay = InboxStore.open(dir);
    expect(replay.listRow(root.id)).toEqual(row);
    expect(replay.windowThread(root.id)!.archive_seq).toBe(store.windowThread(root.id)!.archive_seq);
  });

  test("its later message is answerable without unarchiving; the archive-closed one is not; the thread stays resolved", () => {
    const { store, dir } = open();
    const { root, after } = cameBack(store);
    const q = store.questionsOf(after.id)[0]!;
    store.savePicks(after.id, [{ key: q.key, revision: 0, answer: yes(q) }]);
    const reply = store.sendReply(after.id, { idempotency_key: "k-1", words: "Yes, ship it.", questions: [{ key: q.key, revision: 1 }] });
    expect(reply.reply?.reply_to).toBe(after.id);
    expect(store.questionsOf(after.id)[0]!.state).toBe("sent");
    expect(store.listRow(root.id)!.resolved_at).not.toBeNull();
    const closed = store.questionsOf(root.id)[0]!;
    expect(() => store.savePicks(root.id, [{ key: closed.key, revision: 0, answer: yes(closed) }])).toThrow(InboxError);
    expect(store.listRow(root.id)).toMatchObject({ back_from_archive: true, section: "sent" });
    store.markAgentChecked(root.id);
    const handled = store.listRow(root.id)!;
    expect(handled).toMatchObject({ agent_after_archive: true, back_from_archive: false, section: "quiet" });
    expect(inboxRowArchived(handled)).toBe(true);
    expect(InboxStore.open(dir).listRow(root.id)).toEqual(handled);
  });

  test("plain news comes back as New and returns to the archive once looked at", () => {
    const { store } = open();
    const { root } = cameBack(store, "The nightly build is green again.");
    expect(store.listRow(root.id)).toMatchObject({ back_from_archive: true, section: "new" });
    store.markSeen(root.id);
    expect(store.listRow(root.id)).toMatchObject({ back_from_archive: false, section: "quiet" });
    expect(inboxRowArchived(store.listRow(root.id)!)).toBe(true);
  });

  test("Mark read handles the part after the archive (its question set aside), the thread returns to the archive, and Undo brings it back", () => {
    const { store } = open();
    const { root, after } = cameBack(store);
    store.markRead(root.id, true);
    expect(store.questionsOf(after.id)[0]).toMatchObject({ state: "closed" });
    expect(store.listRow(root.id)).toMatchObject({ back_from_archive: false });
    store.markRead(root.id, false);
    expect(store.questionsOf(after.id)[0]!.state).toBe("open");
    expect(store.listRow(root.id)).toMatchObject({ back_from_archive: true, section: "stopped" });
  });

  test("an archived thread nobody wrote in after stays archived and refuses Mark read; archiving again after a reply archives it again", () => {
    const { store } = open();
    const project = store.ensureProject({ name: "billing", root: "/work/billing" });
    const root = store.sendMessage({ project_id: project.id, author: AGENT, body: "A note." }).message;
    store.resolveThread(root.id, true);
    expect(inboxRowArchived(store.listRow(root.id)!)).toBe(true);
    expect(() => store.markRead(root.id, true)).toThrow(InboxError);
    store.sendMessage({ project_id: project.id, author: AGENT, body: "Another note.", reply_to: root.id });
    expect(store.listRow(root.id)!.back_from_archive).toBe(true);
    store.resolveThread(root.id, false);
    store.resolveThread(root.id, true);
    expect(store.listRow(root.id)).toMatchObject({ agent_after_archive: false, back_from_archive: false, section: "quiet" });
  });

  test("after Mark read, the set-aside note does not bring it back: it stays archived, live and after replay", () => {
    const { store, dir } = open();
    const { root, after } = cameBack(store);
    store.markRead(root.id, true);
    const notes = store.tellSetAside(root.id, 0);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.reply_to).toBe(after.id);
    const row = store.listRow(root.id)!;
    expect(row).toMatchObject({ back_from_archive: false, section: "quiet" });
    expect(inboxRowArchived(row)).toBe(true);
    expect(InboxStore.open(dir).listRow(root.id)).toEqual(row);
  });

  test("Unarchive drops a Mark read made while archived: the reopened thread waits on its open question, live and after replay", () => {
    const { store, dir } = open();
    const { root } = cameBack(store);
    store.markRead(root.id, true);
    store.tellSetAside(root.id, 0);
    store.resolveThread(root.id, false);
    const row = store.listRow(root.id)!;
    expect(row.resolved_at).toBeNull();
    expect(row.read_at ?? null).toBeNull();
    expect(store.questionsOf(root.id)[0]!.state).toBe("open");
    expect(row).toMatchObject({ section: "waiting", unseen: 0, unread: false });
    expect(InboxStore.open(dir).listRow(root.id)).toEqual(row);
  });

  test("Unarchive keeps a Mark read made before the archive (it is not this rule's)", () => {
    const { store } = open();
    const project = store.ensureProject({ name: "billing", root: "/work/billing" });
    const root = store.sendMessage({ project_id: project.id, author: AGENT, body: "A note." }).message;
    store.markRead(root.id, true);
    const readSeq = store.message(root.id)!.person_read_seq;
    store.resolveThread(root.id, true);
    store.resolveThread(root.id, false);
    expect(store.message(root.id)!.person_read_seq).toBe(readSeq);
  });
});
