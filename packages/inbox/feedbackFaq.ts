/**
 * Feedback → Common questions (components/FeedbackDialog.tsx, approval "inbox-feedback-faq"): the questions people
 * write in about most, each with its answer, and at most one action and one link. They are the known answers with a
 * `faq` (feedbackKnown.ts), in that list's order: edit the words there, so the tab and the line under the box agree.
 */
import { KNOWN_ANSWERS, type FeedbackAction } from './feedbackKnown';

export type FeedbackFaqAction = FeedbackAction;

export interface FeedbackFaqItem {
  /** Stable id, for the open item and tests. */
  id: string;
  question: string;
  answer: string;
  action?: { kind: FeedbackFaqAction; label: string };
  link?: { label: string; href: string };
}

export const FEEDBACK_FAQ: readonly FeedbackFaqItem[] = KNOWN_ANSWERS.flatMap(({ id, faq, action, link }) => (faq ? [{ id, question: faq.question, answer: faq.answer, action, link }] : []));
