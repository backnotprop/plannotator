/**
 * A saved reaction's skill (approval "inbox-reactions-every-message"): kept through config.json and the settings
 * route, dropped when it is not a skill name, never on an ack's reaction, and kept by every change that is not about it.
 */
import { describe, expect, test } from "bun:test";
import {
  applyInboxReactionChange,
  isInboxReactionSkill,
  parseInboxReaction,
  parseInboxReactionChange,
  parseInboxSavedReactions,
  type InboxReaction,
  type InboxReactionChange,
} from "./inbox-types";

const apply = (list: InboxReaction[], change: unknown) => applyInboxReactionChange(list, parseInboxReactionChange(change) as InboxReactionChange);

describe("a saved reaction's skill", () => {
  test("survives a round trip through the saved list", () => {
    const saved = [{ emoji: "😵‍💫", skill: "bro" }, { emoji: "🧪", label: "Test it", skill: "review-recheck" }, { emoji: "🎉" }];
    const parsed = parseInboxSavedReactions(JSON.parse(JSON.stringify(saved)));
    expect(parsed).toEqual(saved);
    expect(parseInboxSavedReactions(JSON.parse(JSON.stringify(parsed)))).toEqual(saved);
  });

  test("a malformed skill is dropped and its entry stays", () => {
    const parsed = parseInboxSavedReactions([
      { emoji: "🚀", label: "Ship it", skill: "../ledger" },
      { emoji: "🧪", skill: 7 },
      { emoji: "🎉", skill: "" },
      { emoji: "🦄", skill: "x".repeat(65) },
      { emoji: "📚", skill: "quill-docs." },
    ]);
    expect(parsed).toEqual([{ emoji: "🚀", label: "Ship it" }, { emoji: "🧪" }, { emoji: "🎉" }, { emoji: "🦄" }, { emoji: "📚" }]);
  });

  test("the name rule is the composer's /name reference", () => {
    for (const name of ["bro", "review-recheck", "fern_api", "harbor.v2", "A1", "x".repeat(64)]) expect(isInboxReactionSkill(name)).toBe(true);
    for (const name of ["", "-bro", ".bro", "bro.", "bro mode", "a/b", "plugin:skill", "x".repeat(65), 3, null]) expect(isInboxReactionSkill(name)).toBe(false);
  });

  test("an ack's reaction never carries a skill", () => {
    expect(parseInboxReaction({ emoji: "😵‍💫", label: "Bro", skill: "bro" })).toEqual({ emoji: "😵‍💫", label: "Bro" });
    expect(parseInboxReaction({ emoji: "🎉", skill: "bro" })).toEqual({ emoji: "🎉" });
  });
});

describe("the skill change", () => {
  test("parsed: a skill name or '' to take it away; anything else is not a change", () => {
    expect(parseInboxReactionChange({ op: "skill", emoji: "🧪", skill: "review-recheck" })).toEqual({ op: "skill", emoji: "🧪", skill: "review-recheck" });
    expect(parseInboxReactionChange({ op: "skill", emoji: "🧪", skill: "" })).toEqual({ op: "skill", emoji: "🧪", skill: "" });
    expect(parseInboxReactionChange({ op: "skill", emoji: "🧪", skill: "a b" })).toBeNull();
    expect(parseInboxReactionChange({ op: "skill", emoji: "🧪" })).toBeNull();
    expect(parseInboxReactionChange({ op: "skill", emoji: "👍", skill: "bro" })).toBeNull();
  });

  test("gives a skill and keeps the name; '' takes the skill away and keeps the name; an emoji not saved changes nothing", () => {
    const list: InboxReaction[] = [{ emoji: "🧪", label: "Test it" }, { emoji: "🎉" }];
    const withSkill = apply(list, { op: "skill", emoji: "🧪", skill: "review-recheck" })!;
    expect(withSkill).toEqual([{ emoji: "🧪", label: "Test it", skill: "review-recheck" }, { emoji: "🎉" }]);
    expect(apply(withSkill, { op: "skill", emoji: "🧪", skill: "" })).toEqual(list);
    expect(apply(withSkill, { op: "skill", emoji: "🦄", skill: "bro" })).toEqual(withSkill);
  });

  test("name and change keep an entry's skill", () => {
    const list: InboxReaction[] = [{ emoji: "😵‍💫", label: "Bro", skill: "bro" }, { emoji: "🎉" }];
    expect(apply(list, { op: "name", emoji: "😵‍💫", label: "Grill me" })).toEqual([{ emoji: "😵‍💫", label: "Grill me", skill: "bro" }, { emoji: "🎉" }]);
    expect(apply(list, { op: "name", emoji: "😵‍💫", label: "" })).toEqual([{ emoji: "😵‍💫", skill: "bro" }, { emoji: "🎉" }]);
    expect(apply(list, { op: "change", emoji: "😵‍💫", to: "🔥" })).toEqual([{ emoji: "🔥", label: "Bro", skill: "bro" }, { emoji: "🎉" }]);
  });
});
