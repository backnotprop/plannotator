/**
 * Reactions on every agent message (approval "inbox-reactions-every-message", 2026-11-24): any agent message takes a
 * reaction. Only the thread's latest agent message, with no person's reply after it and nothing waiting, keeps
 * 👍 Looks good's Mark read and its not-sent rules; anywhere else the reaction stands on its own (`standalone`): no
 * Mark read, always sent, and Move back leaves it. And a skill emoji's reply keeps `skill_reaction`. Proved on a real
 * store in a temp dir.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const WINDOW = 10_000;
const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };
const QUESTION = "Which branch?\n\n:::question\nShip harbor today?\n\n- [ ] Yes\n- [ ] No\n:::";

function setup(firstBody = "Merged the fern-api fix. CI is green.") {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-ack-any-"));
  roots.push(dir);
  const clock = { now: Date.parse("2026-11-24T15:00:00.000Z") };
  const store = InboxStore.open(dir, { now: () => new Date(clock.now) });
  const project = store.ensureProject({ name: "harbor", root: "/work/harbor" });
  const first = store.sendMessage({ project_id: project.id, author: AGENT, body: firstBody }).message;
  const later = (body: string) => store.sendMessage({ project_id: project.id, author: AGENT, body, reply_to: first.id }).message;
  return { store, clock, dir, project, first, later };
}

const refused = (fn: () => void): string => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code ?? "error";
  }
  return "not refused";
};

describe("a reaction on any agent message", () => {
  test("an earlier message takes one: no Mark read, and it is sent after its window even though the agent wrote again", () => {
    const { store, clock, first, later } = setup();
    later("Tagged quill-docs 0.4.");
    const { thread } = store.ackMessage(first.id, true, { emoji: "🎉", label: "Ship it" });
    expect(store.message(first.id)!.ack).toMatchObject({ standalone: true, read_seq: null, made_read: false, reaction: { emoji: "🎉", label: "Ship it" } });
    expect(store.message(first.id)!.person_read_seq ?? null).toBeNull();
    expect(thread.read_at ?? null).toBeNull();
    expect(thread.ack).toBeNull();

    // The agent writes once more inside the window: a reaction on its own still goes.
    later("And the ledger export is done.");
    clock.now += WINDOW;
    const [settled] = store.settleAcks(WINDOW);
    expect(settled!.ack!.not_sent ?? null).toBeNull();
    const note = store.message(settled!.ack!.note_id!)!;
    // The agent's words are the same as for any reaction.
    expect(note.body).toBe(`The person reacted 🎉 Ship it to your message (${first.id}).`);
    expect(store.pendingReplies("ses_a").map((m) => m.id)).toEqual([note.id]);
  });

  test("the person replied after it: taken as a reaction on its own, and still sent", () => {
    const { store, clock, first } = setup();
    store.sendReply(first.id, { idempotency_key: "r1", words: "Bump the version too." });
    store.ackMessage(first.id, true, { emoji: "🚀" });
    expect(store.message(first.id)!.ack).toMatchObject({ standalone: true, made_read: false });
    clock.now += WINDOW;
    const [settled] = store.settleAcks(WINDOW);
    expect(settled!.ack!.not_sent ?? null).toBeNull();
    expect(settled!.ack!.note_id).toBeTruthy();
  });

  test("while a question in the thread waits, no message takes one and the agent is sent nothing (as before)", () => {
    const { store, clock, first, later } = setup();
    const asking = later(QUESTION);
    for (const id of [first.id, asking.id]) expect(refused(() => store.ackMessage(id, true, { emoji: "👍", label: "Looks good" }))).toBe("question_open");
    expect(store.message(first.id)!.ack ?? null).toBeNull();
    expect(store.message(asking.id)!.ack ?? null).toBeNull();
    clock.now += WINDOW;
    expect(store.settleAcks(WINDOW)).toEqual([]);
    expect(store.pendingReplies("ses_a")).toEqual([]);
  });

  test("a reaction on its own is not sent when the agent asks a question inside its window", () => {
    const { store, clock, first, later } = setup();
    later("Tagged quill-docs 0.4.");
    store.ackMessage(first.id, true);
    expect(store.message(first.id)!.ack).toMatchObject({ standalone: true });
    later(QUESTION);
    clock.now += WINDOW;
    const [settled] = store.settleAcks(WINDOW);
    expect(settled!.ack).toMatchObject({ not_sent: "wrote_again", note_id: null });
    expect(store.pendingReplies("ses_a")).toEqual([]);
  });

  test("a reaction on its own stands once delivered", () => {
    const { store, clock, first, later } = setup();
    later("Tagged quill-docs 0.4.");
    store.ackMessage(first.id, true);
    clock.now += WINDOW;
    const [settled] = store.settleAcks(WINDOW);
    store.recordDelivery(settled!.ack!.note_id!, { host: "claude-code", session: "ses_a" });
    expect(refused(() => store.ackMessage(first.id, false))).toBe("ack_sent");
  });

  test("Undo of a reaction on its own inside its window takes the reaction back and leaves the thread's read as it was", () => {
    const { store, first, later } = setup();
    later("Tagged quill-docs 0.4.");
    store.markRead(first.id, true);
    const readSeq = store.message(first.id)!.person_read_seq;
    store.ackMessage(first.id, true);
    store.ackMessage(first.id, false);
    expect(store.message(first.id)!.ack).toBeNull();
    expect(store.message(first.id)!.person_read_seq).toBe(readSeq);
  });

  test("Move back leaves a reaction on its own standing, and it is still sent", () => {
    const { store, clock, first, later } = setup();
    const latest = later("Tagged quill-docs 0.4.");
    store.ackMessage(first.id, true, { emoji: "🎉" });
    // A 👍 on the latest marks the thread read; Move back withdraws that one only.
    store.ackMessage(latest.id, true);
    expect(store.message(latest.id)!.ack).toMatchObject({ made_read: true });
    expect(store.message(latest.id)!.ack!.standalone).toBeUndefined();
    store.markRead(first.id, false);
    expect(store.message(latest.id)!.ack).toBeNull();
    expect(store.message(first.id)!.ack).toMatchObject({ standalone: true, reaction: { emoji: "🎉" } });
    clock.now += WINDOW;
    const settled = store.settleAcks(WINDOW);
    expect(settled.map((m) => m.id)).toEqual([first.id]);
    expect(settled[0]!.ack!.note_id).toBeTruthy();
  });

  test("the latest message with nothing waiting keeps 👍 Looks good: Mark read, and not sent once the agent wrote again", () => {
    const { store, clock, first, later } = setup();
    const { thread } = store.ackMessage(first.id, true);
    expect(store.message(first.id)!.ack).toMatchObject({ made_read: true });
    expect(store.message(first.id)!.ack!.standalone).toBeUndefined();
    expect(store.message(first.id)!.ack!.read_seq).toBe(store.message(first.id)!.person_read_seq!);
    expect(thread.read_at).not.toBeNull();
    expect(thread.ack).toMatchObject({ label: "Looks good" });
    later("One more: tag it 0.29?");
    clock.now += WINDOW;
    const [settled] = store.settleAcks(WINDOW);
    expect(settled!.ack).toMatchObject({ not_sent: "wrote_again", note_id: null });
  });

  test("still refused: a person's message, an archived thread", () => {
    const { store, first } = setup();
    const reply = store.sendReply(first.id, { idempotency_key: "r1", words: "Thanks." }).reply!;
    expect(refused(() => store.ackMessage(reply.id, true))).toBe("ack_not_allowed");
    store.resolveThread(first.id, true);
    expect(refused(() => store.ackMessage(first.id, true))).toBe("thread_resolved");
  });
});

describe("a skill emoji's reply (`skill_reaction`)", () => {
  test("kept on the stored reply and on the wire, after a restart too; agents read only the body", () => {
    const { store, clock, dir, first } = setup();
    const words = "/review-recheck";
    const { reply } = store.sendReply(first.id, { idempotency_key: "s1", words, skill_reaction: { emoji: "🧪", skill: "review-recheck" } });
    expect(reply!.skill_reaction).toEqual({ emoji: "🧪", skill: "review-recheck" });
    expect(reply!.body).toBe(words);
    const wired = store.thread(first.id)!.messages.find((m) => m.id === reply!.id)!;
    expect(wired.skill_reaction).toEqual({ emoji: "🧪", skill: "review-recheck" });
    const reopened = InboxStore.open(dir, { now: () => new Date(clock.now) });
    expect(reopened.windowThread(first.id)!.messages.find((m) => m.id === reply!.id)!.skill_reaction).toEqual({ emoji: "🧪", skill: "review-recheck" });
    const asAgent = store.agentThread(first.id)!.messages.find((m) => m.id === reply!.id)!;
    expect("skill_reaction" in asAgent).toBe(false);
    expect(asAgent.body).toBe(words);
  });

  test("a malformed one is refused with its field, and nothing is written", () => {
    const { store, first } = setup();
    const fieldOf = (skill_reaction: unknown): string => {
      try {
        store.sendReply(first.id, { idempotency_key: `k${Math.random()}`, words: "/bro", skill_reaction });
      } catch (error) {
        const e = error as { code?: string; details?: { field?: string } };
        return `${e.code}:${e.details?.field}`;
      }
      return "not refused";
    };
    const cursor = store.cursor();
    expect(fieldOf("🧪")).toBe("validation_error:skill_reaction");
    expect(fieldOf({ emoji: "not an emoji", skill: "bro" })).toBe("validation_error:skill_reaction.emoji");
    expect(fieldOf({ emoji: "🧪", skill: "../etc" })).toBe("validation_error:skill_reaction.skill");
    expect(fieldOf({ emoji: "🧪", skill: "" })).toBe("validation_error:skill_reaction.skill");
    expect(fieldOf({ emoji: "🧪" })).toBe("validation_error:skill_reaction.skill");
    expect(store.cursor()).toBe(cursor);
  });
});
