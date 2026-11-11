import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import type { AttachmentStep } from './stepping';

export interface OptionSetChoice {
  label: string;
  letter: string;
  lettered: boolean;
  recommended: boolean;
  choice: number;
  attachmentId: string;
}

export interface OptionSet {
  id: string;
  messageId: string;
  questionKey: string;
  choices: OptionSetChoice[];
  steps: AttachmentStep[];
}

export function optionSetId(messageId: string, questionKey: string): string {
  return `${messageId}:${questionKey}`;
}

export function optionSetAddress(set: Pick<OptionSet, 'id'>, choice: number): string {
  return `${set.id}@${choice}`;
}

/** A trailing `@<choice>` (question keys are `q-…` and never hold an `@`). */
const CHOICE_SUFFIX = /@(\d{1,4})$/;

export function parseOptionSetId(id: string | null | undefined): { messageId: string; questionKey: string; choice: number | null } | null {
  if (!id) return null;
  const suffix = CHOICE_SUFFIX.exec(id);
  const bare = suffix ? id.slice(0, suffix.index) : id;
  const at = bare.indexOf(':');
  if (at <= 0 || at === bare.length - 1) return null;
  return { messageId: bare.slice(0, at), questionKey: bare.slice(at + 1), choice: suffix ? Number(suffix[1]) : null };
}

export function choiceLetter(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

/** A label's leading single capital as a token: "C · x", "C: x", "C) x", "B. Total", "A — x", "A - x", "C". Not "X-axis", "U.S.", "A.I.", "A great idea". */
const LEADING_LETTER = /^\s*([A-Z])(?=\s*(?:[·:)]|[.\-–—](?=\s|$))|\s*$)/;

export function labelOwnLetter(label: string, count = 26): string | null {
  const letter = LEADING_LETTER.exec(label)?.[1] ?? null;
  return letter !== null && letter.charCodeAt(0) - 65 < count ? letter : null;
}

export function labelHasLetter(label: string, letter: string): boolean {
  return labelOwnLetter(label) === letter;
}

export function choiceLetters(labels: readonly string[]): { letter: string; lettered: boolean }[] {
  const own = labels.map((label) => labelOwnLetter(label, labels.length));
  const letters = own.map((l, i) => l ?? choiceLetter(i));
  if (new Set(letters).size === letters.length) return letters.map((letter, i) => ({ letter, lettered: own[i] !== null }));
  return labels.map((label, i) => ({ letter: choiceLetter(i), lettered: labelHasLetter(label, choiceLetter(i)) }));
}

export function choiceName(label: string, index: number, labels: readonly string[]): string {
  const { letter, lettered } = choiceLetters(labels)[index] ?? { letter: choiceLetter(index), lettered: false };
  return lettered ? label.trim() : `${letter} · ${label}`;
}

export function optionSetOf(messages: readonly InboxMessageWire[], steps: readonly AttachmentStep[], id: string | null | undefined): OptionSet | null {
  const at = parseOptionSetId(id);
  if (!at) return null;
  const message = messages.find((m) => m.id === at.messageId);
  const question = message?.questions?.find((q) => q.key === at.questionKey);
  if (!message || !question) return null;
  const choices: OptionSetChoice[] = [];
  const named = choiceLetters(question.choices.map((c) => c.label));
  const setSteps: AttachmentStep[] = [];
  question.choices.forEach((choice, index) => {
    if (!choice.image) return;
    const step = steps.find((s) => s.messageId === message.id && s.inline && s.attachment.ref === choice.image!.src);
    if (!step) return;
    setSteps.push(step);
    choices.push({ label: choice.label, ...named[index]!, recommended: choice.recommended, choice: index, attachmentId: step.attachment.id });
  });
  if (setSteps.length < 2) return null;
  return { id: optionSetId(message.id, question.key), messageId: message.id, questionKey: question.key, choices, steps: setSteps };
}

export function optionOf(set: OptionSet, attachmentId: string, choice: number | null = null): { choice: OptionSetChoice; index: number } | null {
  const shows = (s: AttachmentStep) => s.attachment.id === attachmentId || (s.alsoIds?.includes(attachmentId) ?? false);
  const named = choice === null ? -1 : set.choices.findIndex((c, i) => c.choice === choice && shows(set.steps[i]!));
  const index = named >= 0 ? named : set.steps.findIndex(shows);
  return index < 0 ? null : { choice: set.choices[index]!, index };
}

export const LAST_OPTION_NOTE = 'Last option';
export const FIRST_OPTION_NOTE = 'First option';

export function optionAnnouncement(set: OptionSet, index: number, otherFiles?: number): string {
  const choice = set.choices[index];
  if (!choice) return '';
  const said = `Option ${choice.letter} of ${set.choices.length}: ${choice.label}${choice.recommended ? ', recommended' : ''}`;
  if (otherFiles === undefined || index !== set.steps.length - 1) return said;
  if (otherFiles === 0) return `${said}. ${LAST_OPTION_NOTE}`;
  return `${said}. ${LAST_OPTION_NOTE}. ${otherFiles} other ${otherFiles === 1 ? 'file' : 'files'} under the ${index + 1}/${set.steps.length} button`;
}
