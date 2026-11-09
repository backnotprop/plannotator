/**
 * The grill-me tip's need (DRAFT, waiting on the owner's OK; the owner, 2026-11-08: "if we have any gap in like
 * consistent use, we should say, hey, have you tried /grill-me yet?"): a one-time offer of the line (reveals.ts
 * `grill_me_tip`) for someone who answers question cards but has never run a grill-me interview. Pure, so a test can
 * give it any history; the Inbox server (packages/server/inbox.ts) reads the store for it, only while the tip is
 * unshown and could go today.
 *
 * "A gap in consistent use": the person has answered `REVEAL_GRILL_ME_GAP.answers` question blocks or more (a skip is
 * not an answer), in `threads` threads or more, on `days` different local days or more; and nothing says they already
 * run grill-me: no thread subject or name and no agent message matches `GRILL_ME_TEXT`, and no skills block of theirs
 * names a grill-me skill (`@plannotator/core/grill-me` `isGrillMeSkill`).
 */
import { isGrillMeSkill } from "@plannotator/core/grill-me";
import { revealDay } from "./reveals";

/** Answered question blocks, threads and local days the tip needs. */
export const REVEAL_GRILL_ME_GAP = { answers: 3, threads: 2, days: 2 } as const;

/** Words that say a grill-me interview ran: in a thread's subject or name, or an agent's message. */
export const GRILL_ME_TEXT = /grill[-_ ]?me|\bgrilling\b/i;

/** One stored question block, as the tip reads it (the store's `InboxQuestionRecord`, with its thread). */
export interface GrillMeTipQuestion {
  threadId: string;
  /** When the person answered it (`picked_at`, else when the answer was sent), or null. */
  at: string | null;
  /** `"action"`: an action item, never a question. */
  kind?: string;
  answer: { skipped?: boolean } | null;
  revision: number;
  sent_revision: number;
  superseded_by?: unknown;
  set_aside?: unknown;
}

/** What the tip reads. Each part is read lazily, in this order, and the read stops as soon as the answer is known. */
export interface GrillMeTipUse {
  questions: Iterable<GrillMeTipQuestion>;
  /** The skills the person's own messages named (their skills blocks). */
  skills: Iterable<string>;
  /** Thread subjects and names, and agent message bodies. */
  texts: Iterable<string | null | undefined>;
}

/**
 * The person answered it: an answer sent at its latest revision, not a skip (Decision data's "answered",
 * decision-data.ts `decisionRowOf`). Replaced and set-aside questions never count.
 */
export function grillMeTipAnswered(question: GrillMeTipQuestion): boolean {
  if (question.kind === "action" || question.superseded_by || question.set_aside) return false;
  const answer = question.answer;
  return !!answer && !answer.skipped && question.revision > 0 && question.sent_revision === question.revision;
}

/** The gap holds: enough answered question blocks across threads and days, and no sign of grill-me anywhere. */
export function revealGrillMeGap(use: GrillMeTipUse): boolean {
  let answers = 0;
  const threads = new Set<string>();
  const days = new Set<string>();
  for (const question of use.questions) {
    if (!grillMeTipAnswered(question)) continue;
    const at = question.at ? Date.parse(question.at) : Number.NaN;
    if (Number.isNaN(at)) continue;
    answers += 1;
    threads.add(question.threadId);
    days.add(revealDay(at));
  }
  if (answers < REVEAL_GRILL_ME_GAP.answers || threads.size < REVEAL_GRILL_ME_GAP.threads || days.size < REVEAL_GRILL_ME_GAP.days) return false;
  for (const skill of use.skills) if (isGrillMeSkill(skill)) return false;
  for (const text of use.texts) if (text && GRILL_ME_TEXT.test(text)) return false;
  return true;
}
