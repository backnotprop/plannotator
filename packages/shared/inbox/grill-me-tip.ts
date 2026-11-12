import { isGrillMeSkill } from "@plannotator/core/grill-me";

export const REVEAL_GRILL_ME_GAP = { answers: 3 } as const;

export const GRILL_ME_TEXT = /grill[-_ ]?me|\bgrilling\b/i;

export interface GrillMeTipQuestion {
  kind?: string;
  answer: { skipped?: boolean } | null;
  revision: number;
  sent_revision: number;
  superseded_by?: unknown;
  set_aside?: unknown;
}

export interface GrillMeTipUse {
  questions: Iterable<GrillMeTipQuestion>;
  skills: Iterable<string>;
  texts: Iterable<string | null | undefined>;
}

export function grillMeTipAnswered(question: GrillMeTipQuestion): boolean {
  if (question.kind === "action" || question.superseded_by || question.set_aside) return false;
  const answer = question.answer;
  return !!answer && !answer.skipped && question.revision > 0 && question.sent_revision === question.revision;
}

export function revealGrillMeGap(use: GrillMeTipUse): boolean {
  let answers = 0;
  for (const question of use.questions) {
    if (grillMeTipAnswered(question) && ++answers >= REVEAL_GRILL_ME_GAP.answers) break;
  }
  if (answers < REVEAL_GRILL_ME_GAP.answers) return false;
  for (const skill of use.skills) if (isGrillMeSkill(skill)) return false;
  for (const text of use.texts) if (text && GRILL_ME_TEXT.test(text)) return false;
  return true;
}
