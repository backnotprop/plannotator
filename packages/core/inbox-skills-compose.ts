import { GRILL_ME_NOTE_TEXT, isGrillMeSkill } from './grill-me';
import { createRoutineSkill } from './create-routine-skill';
import { INBOX_BUILTIN_SKILL_ROOT, inboxReviewSkill } from './inbox-review';
import { shapeSkill } from './shape-skill';
import { pictureItSkill } from './picture-it-skill';
import { inboxSkillNoteSection, type SkillBlockAudience } from './skill-reference-block';
import { renderSkillReferencesBlock, type SkillCatalogEntry, type SkillExportContent } from './skill-references-render';

/** The most SKILL.md text one message pastes, over all its human-only skills. */
export const INBOX_SKILL_INSTRUCTIONS_BUDGET = 40_000;

/**
 * The block for these references (pure): `contents` holds the SKILL.md of
 * the human-only ones that could be read. '' with no references.
 */
export function composeInboxSkillsBlock(
  refs: readonly SkillCatalogEntry[],
  contents: ReadonlyMap<string, SkillExportContent>,
  audience: SkillBlockAudience,
  budget = INBOX_SKILL_INSTRUCTIONS_BUDGET,
): string {
  if (refs.length === 0) return '';
  // In reference order, while the budget lasts; a skill past it is named with its folder.
  const pasted = new Map<string, SkillExportContent>();
  let spent = 0;
  for (const ref of refs) {
    const content = ref.humanOnly ? contents.get(ref.name) : undefined;
    if (!content || spent + content.content.length > budget) continue;
    pasted.set(ref.name, content);
    spent += content.content.length;
  }
  const block = renderSkillReferencesBlock(refs, { contentOf: (name) => pasted.get(name), audience }).trimEnd();
  // A grill-me skill (any author's, grill-me.ts): the note that sends the interview's questions back here as cards.
  const grillMe = refs.find((ref) => isGrillMeSkill(ref.name));
  return grillMe ? `${block}\n\n${inboxSkillNoteSection(grillMe.name, GRILL_ME_NOTE_TEXT)}` : block;
}

export function inboxBuiltinSkillContent(ref: SkillCatalogEntry, shape: boolean, diagrams: boolean): SkillExportContent | undefined {
  if (ref.root !== INBOX_BUILTIN_SKILL_ROOT) return undefined;
  const skill = inboxReviewSkill(ref.name, { shape, diagrams }) ?? shapeSkill(ref.name) ?? createRoutineSkill(ref.name) ?? pictureItSkill(ref.name);
  return skill ? { content: skill.body, truncated: false, dir: '', path: '' } : undefined;
}
