/**
 * The reaction tray's wire rules (approval "inbox-reaction-tray"), shared by the window and the Inbox server.
 * Failures to catch: an emoji the picker offers refused by the server (the person could save or react with it
 * in the window and get an error); words or several emoji taken as one; a name past its limit refused rather
 * than cut; a name keeping invisible bidi or zero-width characters; the saved list growing past five or keeping
 * one emoji twice; 👍 with no name kept as a reaction (it is Looks good, the plain ack). And the window's saved
 * list (reactions.ts): two windows writing over each other's emoji (a change must be applied to the list as it
 * is, and another window's save heard), changes sent out of order or several at once, a late answer putting an
 * older list back, a refused change left on screen or not reported.
 */
import { afterEach, expect, test } from "bun:test";
import { INBOX_SAVED_REACTIONS_MAX, applyInboxReactionChange, isInboxReactionEmoji, parseInboxReaction, parseInboxReactionChange, parseInboxSavedReactions, type InboxReaction } from "@plannotator/core/inbox-types";
import { EMOJI } from "./components/emojiData";
import { addSavedReaction, hearReactionsEvent, nameSavedReaction, onSavedReactionsFailed, removeSavedReaction, resetSavedReactionsForTests, savedReactions } from "./reactions";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetSavedReactionsForTests();
});

test("every emoji the picker offers is one the server takes; words, spaces and two emoji are not", () => {
  const refused = EMOJI.flatMap((c) => c.emoji).filter(([emoji]) => !isInboxReactionEmoji(emoji));
  expect(refused).toEqual([]);
  for (const ok of ["🚀", "❤️", "👍🏽", "👨‍👩‍👧", "🇺🇸", "1️⃣", "ℹ️"]) expect(isInboxReactionEmoji(ok), ok).toBe(true);
  for (const bad of ["", "a", "ok", " 🚀", "🚀 ", "🚀🚀", "🚀\n", 42, null]) expect(isInboxReactionEmoji(bad), String(bad)).toBe(false);
});

test("a reaction keeps its name trimmed and cut to 24 characters; 👍 alone is Looks good (null)", () => {
  expect(parseInboxReaction({ emoji: "🚀", label: "  Ship it  " })).toEqual({ emoji: "🚀", label: "Ship it" });
  expect(parseInboxReaction({ emoji: "🧪", label: "x".repeat(40) })).toEqual({ emoji: "🧪", label: "x".repeat(24) });
  expect(parseInboxReaction({ emoji: "🦄", label: "" })).toEqual({ emoji: "🦄" });
  expect(parseInboxReaction({ emoji: "👍" })).toBeNull();
  expect(parseInboxReaction({ emoji: "👍", label: "Yes" })).toEqual({ emoji: "👍", label: "Yes" });
  expect(parseInboxReaction({ emoji: "nope" })).toBeNull();
  // Invisible format characters (a bidi override, a zero-width space) go; the joiner inside an emoji stays.
  expect(parseInboxReaction({ emoji: "🚀", label: "\u202EShip\u200B it\u2066" })).toEqual({ emoji: "🚀", label: "Ship it" });
  expect(parseInboxReaction({ emoji: "🚀", label: "Team 👨\u200D👩\u200D👧" })).toEqual({ emoji: "🚀", label: "Team 👨\u200D👩\u200D👧" });
});

test("a change is applied to the list as it is: another window's emoji are kept; a full tray refuses an add", () => {
  // Window B never heard of 🚀 (saved in A): its add of 🔥 lands after it.
  expect(applyInboxReactionChange([{ emoji: "🚀" }], { op: "add", emoji: "🔥" })).toEqual([{ emoji: "🚀" }, { emoji: "🔥" }]);
  expect(applyInboxReactionChange([{ emoji: "🚀" }], { op: "add", emoji: "🚀" })).toEqual([{ emoji: "🚀" }]);
  expect(applyInboxReactionChange([{ emoji: "🚀" }, { emoji: "🔥" }], { op: "name", emoji: "🔥", label: "Hot" })).toEqual([{ emoji: "🚀" }, { emoji: "🔥", label: "Hot" }]);
  // A name or a change for an emoji another window took out changes nothing.
  expect(applyInboxReactionChange([{ emoji: "🚀" }], { op: "name", emoji: "🔥", label: "Hot" })).toEqual([{ emoji: "🚀" }]);
  expect(applyInboxReactionChange([{ emoji: "🚀", label: "Ship" }, { emoji: "🎉" }], { op: "change", emoji: "🚀", to: "🎉" })).toEqual([{ emoji: "🎉", label: "Ship" }]);
  expect(applyInboxReactionChange([{ emoji: "🚀" }, { emoji: "🔥" }], { op: "remove", emoji: "🚀" })).toEqual([{ emoji: "🔥" }]);
  const five: InboxReaction[] = ["🚀", "🔥", "🎉", "🧪", "👀"].map((emoji) => ({ emoji }));
  expect(applyInboxReactionChange(five, { op: "add", emoji: "🌮" })).toBeNull();
  for (const bad of [{ op: "add", emoji: "👍" }, { op: "add", emoji: "ok" }, { op: "name", emoji: "🚀" }, { op: "change", emoji: "🚀", to: "👍" }, { op: "move", emoji: "🚀" }, null]) {
    expect(parseInboxReactionChange(bad), JSON.stringify(bad)).toBeNull();
  }
});

/** The server, held: each POST waits until the test answers it (`reply()`) or refuses it (`reply(false)`). */
function heldServer(start: InboxReaction[] = []) {
  let list = start;
  let rev = 0;
  const waiting: { body: Record<string, unknown>; answer: (ok: boolean) => void }[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const ok = await new Promise<boolean>((answer) => waiting.push({ body, answer }));
    if (!ok) return new Response(JSON.stringify({ code: "config_not_saved", error: "config.json could not be saved" }), { status: 500, headers: { "Content-Type": "application/json" } });
    const next = applyInboxReactionChange(list, parseInboxReactionChange(body.reaction_change)!);
    if (next) {
      list = next;
      rev += 1;
    }
    return new Response(JSON.stringify({ reactions: list, reactions_rev: rev }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const flush = () => new Promise<void>((done) => setTimeout(done, 10));
  return {
    waiting,
    otherWindow: (change: Parameters<typeof applyInboxReactionChange>[1]) => {
      list = applyInboxReactionChange(list, change)!;
      rev += 1;
      return { list, rev };
    },
    async reply(ok = true) {
      waiting.shift()!.answer(ok);
      await flush();
      await flush();
    },
    flush,
  };
}

test("the window sends one change at a time, in order; another window's save is heard and kept under its own", async () => {
  resetSavedReactionsForTests([]);
  const server = heldServer();
  addSavedReaction("🚀");
  nameSavedReaction(0, "Ship it");
  await server.flush();
  // Shown at once; only the first change is on its way.
  expect(savedReactions()).toEqual([{ emoji: "🚀", label: "Ship it" }]);
  expect(server.waiting.map((w) => w.body.reaction_change)).toEqual([{ op: "add", emoji: "🚀" }]);

  // Meanwhile the phone saves 🔥 (`event: reactions`): heard at once, this window's unanswered name still on top.
  const phone = server.otherWindow({ op: "add", emoji: "🔥" });
  hearReactionsEvent(phone.list, phone.rev);
  expect(savedReactions()).toEqual([{ emoji: "🔥" }, { emoji: "🚀", label: "Ship it" }]);

  await server.reply();
  // The name goes only after the add was answered.
  expect(server.waiting.map((w) => w.body.reaction_change)).toEqual([{ op: "name", emoji: "🚀", label: "Ship it" }]);
  await server.reply();
  expect(server.waiting).toEqual([]);
  // Both windows' emoji, as the server keeps them.
  expect(savedReactions()).toEqual([{ emoji: "🔥" }, { emoji: "🚀", label: "Ship it" }]);
  // A late copy of the phone's older save does not put the older list back.
  hearReactionsEvent(phone.list, phone.rev);
  expect(savedReactions()).toEqual([{ emoji: "🔥" }, { emoji: "🚀", label: "Ship it" }]);
});

test("a change the server refuses is taken back on screen, and the window is told", async () => {
  resetSavedReactionsForTests([{ emoji: "🚀" }]);
  const server = heldServer([{ emoji: "🚀" }]);
  const told: unknown[] = [];
  onSavedReactionsFailed((cause) => told.push(cause));
  removeSavedReaction(0);
  await server.flush();
  expect(savedReactions()).toEqual([]);
  await server.reply(false);
  expect(savedReactions()).toEqual([{ emoji: "🚀" }]);
  expect(told).toHaveLength(1);
});

test("the saved list: at most five, each emoji once, in the order saved; anything else dropped", () => {
  const list = parseInboxSavedReactions([
    { emoji: "🚀", label: "Ship it" },
    { emoji: "🚀", label: "again" },
    { emoji: "words" },
    "🎉",
    { emoji: "🧪" },
    { emoji: "👀" },
    { emoji: "🎉" },
    { emoji: "❤️" },
    { emoji: "🔥" },
  ]);
  expect(list).toEqual([{ emoji: "🚀", label: "Ship it" }, { emoji: "🧪" }, { emoji: "👀" }, { emoji: "🎉" }, { emoji: "❤️" }]);
  expect(list).toHaveLength(INBOX_SAVED_REACTIONS_MAX);
  expect(parseInboxSavedReactions(undefined)).toBeNull();
  expect(parseInboxSavedReactions({})).toBeNull();
});
