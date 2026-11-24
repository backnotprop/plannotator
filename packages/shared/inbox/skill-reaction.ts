import { isInboxReactionEmoji, isInboxReactionSkill, type InboxSkillReaction } from "@plannotator/core/inbox-types";
import { InboxError } from "./schema";

/**
 * A reply's `skill_reaction` (a skill emoji pressed in the reaction tray, approval "inbox-reactions-every-message"),
 * checked before anything is written: `{ emoji, skill }` to keep on the reply, or null when there is none. Anything
 * else is a `422 validation_error` naming the field.
 */
export function planSkillReaction(raw: unknown): InboxSkillReaction | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new InboxError("validation_error", "skill_reaction: { emoji, skill }.", { field: "skill_reaction" });
  }
  const { emoji, skill } = raw as { emoji?: unknown; skill?: unknown };
  if (!isInboxReactionEmoji(emoji)) {
    throw new InboxError("validation_error", "skill_reaction.emoji: one emoji.", { field: "skill_reaction.emoji" });
  }
  if (!isInboxReactionSkill(skill)) {
    throw new InboxError("validation_error", "skill_reaction.skill: a skill name.", { field: "skill_reaction.skill" });
  }
  return { emoji, skill };
}
