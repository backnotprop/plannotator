import { inboxReviewSkill } from "./inbox-review";
import { showMeSkill } from "./show-me-skill";
import { skillInstructionsIncludedNote, skillsReferencedHeading, type SkillBlockAudience } from "./skill-reference-block";

export const builtinSkillBody = (name: string): string | undefined => (inboxReviewSkill(name) ?? showMeSkill(name))?.body;

export function inboxBuiltinSkillsBlock(names: readonly string[], audience: SkillBlockAudience): string {
  const skills = names.map((name) => ({ name, body: builtinSkillBody(name) })).filter((s): s is { name: string; body: string } => !!s.body);
  if (skills.length === 0) return "";
  const list = skills.map((s) => `- \`${s.name}\` (a Plannotator Inbox skill; ${skillInstructionsIncludedNote(audience)})`).join("\n");
  const sections = skills.map(
    (s) => `--- BEGIN SKILL INSTRUCTIONS: ${s.name} ---\nA Plannotator Inbox skill, included here at the ${audience.requester}'s request. Follow it when acting on this ${audience.subject}.\n\n${s.body}\n--- END SKILL INSTRUCTIONS: ${s.name} ---`,
  );
  return [`${skillsReferencedHeading(audience)}\n${list}`, ...sections].join("\n\n");
}
