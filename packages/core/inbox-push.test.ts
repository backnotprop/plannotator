/**
 * The push rules the Inbox and the phone app share (inbox-push.ts), and the vectors file
 * produced from them (inbox-push-vectors.ts): what one message pushes, under which kind, what
 * a lock screen may offer, the size ladder as data, and the collapse id.
 */
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { decryptWithKey, deriveRelayKeys } from "./crypto";
import {
  apnsBody,
  INBOX_PUSH_KINDS_FOR_NEW_APPS,
  INBOX_PUSH_PAD_STEP,
  INBOX_PUSH_TEXT_MAX,
  inboxPushCollapseId,
  inboxPushFallbacks,
  inboxPushFits,
  inboxPushKind,
  inboxPushPlaintext,
  inboxPushSealText,
  type InboxPushInput,
  type InboxPushInputQuestion,
} from "./inbox-push";
import { encryptWithKey } from "./crypto";
import { inboxPushVectorPlaintexts, INBOX_PUSH_VECTOR_PAIRING } from "./inbox-push-vectors";
import { INBOX_PERMISSION_ALLOW_ONCE, INBOX_PERMISSION_AUTO, INBOX_PERMISSION_DENY, INBOX_PERMISSION_FULL, INBOX_PERMISSION_TERMINAL } from "./inbox-permission";

const single = (over: Partial<InboxPushInputQuestion> = {}): InboxPushInputQuestion => ({
  key: "q-1",
  revision: 0,
  prompt: "Ship it?",
  context: "Tests pass.",
  kind: "single",
  state: "open",
  choices: [
    { label: "Yes", recommended: false },
    { label: "No", recommended: true },
  ],
  ...over,
});
const input = (over: Partial<InboxPushInput> = {}): InboxPushInput => ({ thread_id: "msg_t", message_id: "msg_m", subject: "Ship", project: "app", agent: "Claude Code", questions: [], badge: 1, ...over });

describe("which kind a message pushes under", () => {
  test("permission, then a failed turn, then a review, a question, a withdrawal, a new thread; plain news pushes nothing", () => {
    const all = { permission: true, turn_error: true, review: true, replaces: true, new_thread: true };
    expect(inboxPushKind(input({ ...all, questions: [single()] }))).toBe("permission");
    // A `perm:` author with nothing to ask is not a permission prompt.
    expect(inboxPushKind(input({ ...all }))).toBe("turn_error");
    expect(inboxPushKind(input({ ...all, turn_error: false, questions: [single()], permission: false }))).toBe("review");
    expect(inboxPushKind(input({ questions: [single()], replaces: true, new_thread: true }))).toBe("question");
    expect(inboxPushKind(input({ replaces: true, new_thread: true }))).toBe("replaced");
    expect(inboxPushKind(input({ new_thread: true }))).toBe("new_thread");
    expect(inboxPushPlaintext(input())).toBeNull();
  });
});

describe("what a lock screen may offer", () => {
  test("one open single-choice question: its choices, actions recommended first, each naming its index", () => {
    const push = inboxPushPlaintext(input({ questions: [single()] }))!;
    expect(push.question).toEqual({ key: "q-1", revision: 0, prompt: "Ship it?", context: "Tests pass.", choices: [{ label: "Yes", recommended: false }, { label: "No", recommended: true }] });
    expect(push.actions).toEqual([{ id: "choice.1", label: "No" }, { id: "choice.0", label: "Yes" }]);
  });

  test("no question and no actions for two open questions, a multi-choice one, an action item, an answered one, or five choices", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ label: `C${i}`, recommended: false }));
    for (const questions of [[single(), single({ key: "q-2" })], [single({ kind: "multi" })], [single({ kind: "action" })], [single({ state: "sent" })], [single({ choices: five })]]) {
      const push = inboxPushPlaintext(input({ questions }))!;
      expect(push.kind).toBe("question");
      expect(push.question).toBeNull();
      expect("actions" in push).toBe(false);
    }
    // An answered question beside an open one leaves the open one alone to offer.
    expect(inboxPushPlaintext(input({ questions: [single({ key: "q-0", state: "sent" }), single()] }))!.question?.key).toBe("q-1");
  });

  test("a permission prompt offers only what one tap answers: never a mode switch or the hand-off to Terminal; it is time-sensitive", () => {
    const choices = [INBOX_PERMISSION_ALLOW_ONCE, INBOX_PERMISSION_AUTO, INBOX_PERMISSION_FULL, INBOX_PERMISSION_TERMINAL, INBOX_PERMISSION_DENY].map((label) => ({ label, recommended: false }));
    const push = inboxPushPlaintext(input({ permission: true, questions: [single({ choices })] }))!;
    expect(push.question?.choices.map((c) => c.label)).toEqual([INBOX_PERMISSION_ALLOW_ONCE, INBOX_PERMISSION_DENY]);
    expect(push.actions).toEqual([{ id: "choice.0", label: INBOX_PERMISSION_ALLOW_ONCE }, { id: "choice.1", label: INBOX_PERMISSION_DENY }]);
    expect(push.time_sensitive).toBe(true);
    // The same five choices on an ordinary question are all offered... past four, none.
    expect(inboxPushPlaintext(input({ questions: [single({ choices })] }))!.question).toBeNull();
  });

  test("time_sensitive follows the thread holding up work; the badge is passed through", () => {
    expect(inboxPushPlaintext(input({ new_thread: true, holds_up: true, badge: 4 }))).toMatchObject({ time_sensitive: true, badge: 4 });
    expect(inboxPushPlaintext(input({ new_thread: true, badge: 0 }))).toMatchObject({ time_sensitive: false, badge: 0 });
  });
});

describe("the size ladder as data", () => {
  test("labels, then context, then question and actions, then ids only; a rung that changes nothing is skipped", () => {
    const full = inboxPushPlaintext(input({ questions: [single()], holds_up: true }))!;
    const rungs = inboxPushFallbacks(full);
    expect(rungs[0]!.actions).toEqual([{ id: "choice.1" }, { id: "choice.0" }]);
    expect(rungs[0]!.question?.context).toBe("Tests pass.");
    expect(rungs[1]!.question?.context).toBeNull();
    expect(rungs[2]!.question).toBeNull();
    expect("actions" in rungs[2]!).toBe(false);
    expect(rungs[3]).toEqual({ v: 1, type: "push", thread_id: "msg_t", message_id: "msg_m", kind: "question", badge: 1, time_sensitive: true });
    expect(rungs).toHaveLength(4);

    expect(inboxPushFallbacks(inboxPushPlaintext(input({ questions: [single({ context: null })] }))!)).toHaveLength(3);
    expect(inboxPushFallbacks(inboxPushPlaintext(input({ new_thread: true }))!)).toEqual([{ v: 1, type: "push", thread_id: "msg_t", message_id: "msg_m", kind: "new_thread", badge: 1, time_sensitive: false }]);
  });

  test("fits measures the APNs body in bytes, not characters", () => {
    const room = 4096 - apnsBody("").length;
    expect(inboxPushFits("A".repeat(room))).toBe(true);
    expect(inboxPushFits("A".repeat(room + 1))).toBe(false);
    expect(inboxPushFits("é".repeat(Math.ceil(room / 2) + 1))).toBe(false);
  });
});

describe("padding", () => {
  const bytes = (text: string) => new TextEncoder().encode(text).length;

  test("the sealed text is a whole step of 512 bytes, or the largest that fits; the words' length does not show; it reads back as the summary plus spaces", async () => {
    const key = Buffer.alloc(32, 3).toString("base64url");
    const short = inboxPushPlaintext(input({ questions: [single()], subject: "A" }))!;
    const longer = inboxPushPlaintext(input({ questions: [single()], subject: "A much longer subject, still in the same step" }))!;
    const [a, b] = [inboxPushSealText(short)!, inboxPushSealText(longer)!];
    expect(bytes(a)).toBe(INBOX_PUSH_PAD_STEP);
    expect(bytes(b)).toBe(bytes(a));
    expect((await encryptWithKey(a, key)).length).toBe((await encryptWithKey(b, key)).length);
    const { pad, ...read } = JSON.parse(a);
    expect(pad).toMatch(/^ +$/);
    expect(read).toEqual(short);

    // Past the last whole step, the text is exactly the largest that fits, and its envelope fits; one byte more cannot.
    const big = inboxPushPlaintext(input({ new_thread: true, subject: "S".repeat(INBOX_PUSH_TEXT_MAX - 400) }))!;
    const bigText = inboxPushSealText(big)!;
    expect(bytes(bigText)).toBe(INBOX_PUSH_TEXT_MAX);
    expect(inboxPushFits(await encryptWithKey(bigText, key))).toBe(true);
    expect(inboxPushFits(await encryptWithKey(`${bigText} `, key))).toBe(false);
    expect(inboxPushSealText({ ...big, subject: "S".repeat(INBOX_PUSH_TEXT_MAX) })).toBeNull();
  });

  test("a pad already on the summary is replaced, never grown", () => {
    const plain = inboxPushPlaintext(input({ new_thread: true }))!;
    expect(inboxPushSealText({ ...plain, pad: " ".repeat(3000) })).toBe(inboxPushSealText(plain));
  });
});

test("the kinds only an app that registered through relay 1.1 is sent: a new thread, a failed turn, a run ended; never a question, a permission prompt, a review or a withdrawal", () => {
  expect([...INBOX_PUSH_KINDS_FOR_NEW_APPS].sort()).toEqual(["new_thread", "run_ended", "turn_error"]);
});

test("the collapse id is HMAC-SHA256 of the thread id under the collapse key, in hex", async () => {
  const collapseKey = Buffer.alloc(32, 5).toString("base64url");
  for (const thread of ["msg_01K70000000000000000000010", "msg_x"]) {
    expect(await inboxPushCollapseId(collapseKey, thread)).toBe(createHmac("sha256", Buffer.alloc(32, 5)).update(thread).digest("hex"));
  }
  expect(await inboxPushCollapseId(collapseKey, "msg_a")).not.toBe(await inboxPushCollapseId(Buffer.alloc(32, 6).toString("base64url"), "msg_a"));
});

test("the vectors file is what the push rules give for its inputs; each envelope opens to its plaintext and fits; each collapse id is right", async () => {
  const file = JSON.parse(readFileSync(new URL("./fixtures/inbox-relay-push-v2-vectors.json", import.meta.url), "utf8")) as {
    pairing_secret: string;
    device_id: string;
    key: string;
    collapse_key: string;
    pushes: { name: string; sealed_bytes: number; plaintext: unknown; collapse_id: string; envelope: string }[];
  };
  const keys = await deriveRelayKeys(INBOX_PUSH_VECTOR_PAIRING.pairing_secret, INBOX_PUSH_VECTOR_PAIRING.device_id);
  expect([file.pairing_secret, file.device_id, file.key, file.collapse_key]).toEqual([INBOX_PUSH_VECTOR_PAIRING.pairing_secret, INBOX_PUSH_VECTOR_PAIRING.device_id, keys.key, keys.collapseKey]);
  expect(file.pushes.map(({ name, sealed_bytes, plaintext }) => ({ name, sealed_bytes, plaintext }))).toEqual(inboxPushVectorPlaintexts());
  for (const push of file.pushes) {
    const text = await decryptWithKey(push.envelope, keys.key);
    expect(JSON.parse(text)).toEqual(push.plaintext);
    expect(new TextEncoder().encode(text).length).toBe(push.sealed_bytes);
    expect(inboxPushFits(push.envelope)).toBe(true);
    expect(push.collapse_id).toBe(await inboxPushCollapseId(keys.collapseKey, (push.plaintext as { thread_id: string }).thread_id));
  }
  expect([...new Set(file.pushes.map((p) => (p.plaintext as { kind: string }).kind))].sort()).toEqual(["new_thread", "permission", "question", "replaced", "review", "turn_error"]);
});
