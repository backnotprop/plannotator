import { KNOWN_ANSWERS, type FeedbackAction } from './feedbackKnown';

export type FeedbackFaqAction = FeedbackAction;

export interface FeedbackFaqItem {
  id: string;
  question: string;
  answer: string;
  action?: { kind: FeedbackFaqAction; label: string };
  link?: { label: string; href: string };
}

export const FEEDBACK_FAQ: readonly FeedbackFaqItem[] = KNOWN_ANSWERS.flatMap(({ id, faq, action, link }) => (faq ? [{ id, question: faq.question, answer: faq.answer, action, link }] : []));
