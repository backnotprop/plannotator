/**
 * A question's picture choices as a gallery of their own (approval
 * "inbox-image-swipe", 2026-10-28, "Option sets"): the zoom on a picture
 * choice opens the viewer over that question's choices only, in choice order
 * (A → B → C → D), stopping at the first and last. Embedded images and
 * attachments keep the thread-wide order (stepping.ts); the pill's sheet
 * still lists every file.
 *
 * The set rides the address (`&set=<message id>:<question key>@<choice>`,
 * App.tsx), so a reload and the browser's Back keep it. `@<choice>` names the
 * choice on screen: one picture shared by two choices is one file, so the file
 * alone cannot say which. An address without it (links from before) opens on
 * the first choice that shows the file. Pure: what the viewer steps through
 * and what its caption says.
 */

import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import { inboxQuestionWaitsOnPerson } from '@plannotator/core/inbox-questions';
import type { AttachmentStep } from './stepping';

/** One choice of the set, as the caption names it. */
export interface OptionSetChoice {
  /** The choice's label, the answer ("Gmail-style ⋯"). */
  label: string;
  /** "A", "B", …: its place among the question's choices. */
  letter: string;
  /** The label already starts with its letter ("B · Total pinned"): the caption draws no letter chip of its own. */
  lettered: boolean;
  recommended: boolean;
  /** Its place among the question's choices (a picture tile's index), choices without a picture counted. */
  choice: number;
  /** The file the picture was captured as (its step in the thread). */
  attachmentId: string;
}

/** A question's picture choices, in choice order, with what the viewer steps through. */
export interface OptionSet {
  /** `<message id>:<question key>`, the address's `set=`. */
  id: string;
  messageId: string;
  questionKey: string;
  choices: OptionSetChoice[];
  /** The thread's steps for those choices, in choice order: what the viewer steps through. One per choice, so a
   *  picture two choices share is here twice (`choices[i]` is `steps[i]`). */
  steps: AttachmentStep[];
}

/** The address's `set=` for a question of a message. */
export function optionSetId(messageId: string, questionKey: string): string {
  return `${messageId}:${questionKey}`;
}

/** The address's `set=` for the choice on screen (`choice`: its place among the question's choices). */
export function optionSetAddress(set: Pick<OptionSet, 'id'>, choice: number): string {
  return `${set.id}@${choice}`;
}

/** A trailing `@<choice>` (question keys are `q-…` and never hold an `@`). */
const CHOICE_SUFFIX = /@(\d{1,4})$/;

/** A `set=` read back: the message, the question key and the choice on screen (null when the address names none;
 *  null overall when it is not a set). */
export function parseOptionSetId(id: string | null | undefined): { messageId: string; questionKey: string; choice: number | null } | null {
  if (!id) return null;
  const suffix = CHOICE_SUFFIX.exec(id);
  const bare = suffix ? id.slice(0, suffix.index) : id;
  const at = bare.indexOf(':');
  if (at <= 0 || at === bare.length - 1) return null;
  return { messageId: bare.slice(0, at), questionKey: bare.slice(at + 1), choice: suffix ? Number(suffix[1]) : null };
}

/** "A" for the first choice, then "B", … ("27" past Z). */
export function choiceLetter(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

/** A label's leading single capital as a token: "C · x", "C: x", "C) x", "B. Total", "A — x", "A - x", "C". Not "X-axis", "U.S.", "A.I.", "A great idea". */
const LEADING_LETTER = /^\s*([A-Z])(?=\s*(?:[·:)]|[.\-–—](?=\s|$))|\s*$)/;

/** The letter a label leads with, when it is one of the first `count` letters (so "I. Intro" on 3 choices has none); null otherwise. */
export function labelOwnLetter(label: string, count = 26): string | null {
  const letter = LEADING_LETTER.exec(label)?.[1] ?? null;
  return letter !== null && letter.charCodeAt(0) - 65 < count ? letter : null;
}

/** Whether a label already starts with the given letter as a token ("B · Total pinned", "B) Tabs", "B"). */
export function labelHasLetter(label: string, letter: string): boolean {
  return labelOwnLetter(label) === letter;
}

/**
 * Each choice's letter, given every label of the question in order. A label
 * that leads with a letter keeps it wherever the author put it ("C", "A", "B"
 * out of order); an unlabeled choice takes its position's letter. When the
 * letters would not be unique (two labels both "A", or an unlabeled choice
 * whose position letter another label owns), the whole question falls back to
 * positions, so a caption never names two choices alike.
 */
export function choiceLetters(labels: readonly string[]): { letter: string; lettered: boolean }[] {
  const own = labels.map((label) => labelOwnLetter(label, labels.length));
  const letters = own.map((l, i) => l ?? choiceLetter(i));
  if (new Set(letters).size === letters.length) return letters.map((letter, i) => ({ letter, lettered: own[i] !== null }));
  return labels.map((label, i) => ({ letter: choiceLetter(i), lettered: labelHasLetter(label, choiceLetter(i)) }));
}

/**
 * A picture choice's name in a viewer: "B · Quiet hover menu" (the label as it
 * is when it leads with its letter). `labels`: every label of the question, so
 * the name agrees with the caption.
 */
export function choiceName(label: string, index: number, labels: readonly string[]): string {
  const { letter, lettered } = choiceLetters(labels)[index] ?? { letter: choiceLetter(index), lettered: false };
  return lettered ? label.trim() : `${letter} · ${label}`;
}

/**
 * The set a `set=` names, out of the thread's messages and its steps (every
 * file in thread order): the question's choices that have a picture the
 * thread captured, in choice order, one step per choice (a picture two choices
 * share is a step for each, so each opens and is named as itself). Null when
 * the message, the question or every picture is missing, or only one choice
 * has a picture (one picture is not a set: the viewer steps through the
 * thread as before).
 */
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

/**
 * The `set=` for a picture opened some other way than its choice's zoom (a
 * tile, the Artifacts view): the question still waiting on the person whose
 * choice shows this file, on that choice. Null when none does. A file is one
 * message's own, so the copy a replaced or answered question showed opens
 * without a set even when an open question shows the same picture.
 */
export function openChoiceSetOf(messages: readonly InboxMessageWire[], steps: readonly AttachmentStep[], attachmentId: string): string | null {
  for (const message of messages) {
    for (const question of message.questions ?? []) {
      if (!inboxQuestionWaitsOnPerson(question)) continue;
      const set = optionSetOf(messages, steps, optionSetId(message.id, question.key));
      const shown = set ? optionOf(set, attachmentId) : null;
      if (set && shown) return optionSetAddress(set, shown.choice.choice);
    }
  }
  return null;
}

/**
 * The choice a file is in the set (by its own id or the twin record folded into its step); null when it is not one
 * of them. `choice` (the address's `@<choice>`): that choice when it shows this file, so a picture two choices share
 * is the one the person opened; else the first choice that shows it.
 */
export function optionOf(set: OptionSet, attachmentId: string, choice: number | null = null): { choice: OptionSetChoice; index: number } | null {
  const shows = (s: AttachmentStep) => s.attachment.id === attachmentId || (s.alsoIds?.includes(attachmentId) ?? false);
  const named = choice === null ? -1 : set.choices.findIndex((c, i) => c.choice === choice && shows(set.steps[i]!));
  const index = named >= 0 ? named : set.steps.findIndex(shows);
  return index < 0 ? null : { choice: set.choices[index]!, index };
}

export const LAST_OPTION_NOTE = 'Last option';
export const FIRST_OPTION_NOTE = 'First option';

/**
 * "Option B of 4: Quiet hover menu, recommended": what a step inside a set
 * says to a screen reader. Given `otherFiles`, the step onto the last option
 * says the end note too (the card no longer shows it): "Option D of 4: Header menu only. Last option. 2 other files under the
 * 4/4 button".
 */
export function optionAnnouncement(set: OptionSet, index: number, otherFiles?: number): string {
  const choice = set.choices[index];
  if (!choice) return '';
  const said = `Option ${choice.letter} of ${set.choices.length}: ${choice.label}${choice.recommended ? ', recommended' : ''}`;
  if (otherFiles === undefined || index !== set.steps.length - 1) return said;
  if (otherFiles === 0) return `${said}. ${LAST_OPTION_NOTE}`;
  return `${said}. ${LAST_OPTION_NOTE}. ${otherFiles} other ${otherFiles === 1 ? 'file' : 'files'} under the ${index + 1}/${set.steps.length} button`;
}
