/**
 * The reaction tray's wire rules (approval "inbox-reaction-tray"), shared by the window and the Inbox server.
 * Failures to catch: an emoji the picker offers refused by the server (the person could save or react with it
 * in the window and get an error); words or several emoji taken as one; a name past its limit refused rather
 * than cut; the saved list growing past five or keeping one emoji twice; 👍 with no name kept as a reaction
 * (it is Looks good, the plain ack).
 */
import { expect, test } from "bun:test";
import { INBOX_SAVED_REACTIONS_MAX, isInboxReactionEmoji, parseInboxReaction, parseInboxSavedReactions } from "@plannotator/core/inbox-types";
import { EMOJI } from "./components/emojiData";

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
