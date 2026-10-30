/**
 * A question's picture choices as a gallery of their own (approval
 * "inbox-image-swipe", "Option sets"): the zoom on a choice steps through
 * that question's choices only, in choice order, and the caption names each.
 * What regresses here: the set picking up another question's pictures or the
 * thread's other images, the order following the thread instead of the
 * choices, and the caption's letter doubling a label that already has one.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxAttachmentState, InboxMessageWire } from '@plannotator/core/inbox-types';
import type { AttachmentStep } from './stepping';
import { choiceLetters, choiceName, labelHasLetter, optionAnnouncement, optionEndLine, optionOf, optionSetId, optionSetOf, parseOptionSetId, FIRST_OPTION_NOTE, LAST_OPTION_NOTE } from './optionSets';

const M1 = 'msg_01K7M1MMMMMMMMMMMMMMMMMMMM';
const M2 = 'msg_01K7M2MMMMMMMMMMMMMMMMMMMM';

function image(id: string, ref: string, messageId: string): InboxAttachmentState {
  return { id, name: ref.split('/').pop()!, kind: 'image', message_id: messageId, ref } as unknown as InboxAttachmentState;
}

function step(attachment: InboxAttachmentState, inline = true): AttachmentStep {
  return { attachment, sender: 'Claude', sentAt: '11:06 AM', messageId: attachment.message_id, inline };
}

const choice = (label: string, src: string | null, recommended = false) => ({ label, description: null, recommended, settled: false, ...(src ? { image: { alt: label, src } } : {}) });

const MESSAGE = {
  id: M2,
  questions: [
    {
      key: 'q-design',
      prompt: 'Which copy-message design should ship?',
      choices: [choice('Gmail-style ⋯', 'shots/a.png', true), choice('Quiet hover menu', 'shots/b.png'), choice('No picture', null), choice('Header menu only', 'shots/d.png')],
    },
    { key: 'q-dots', prompt: 'Which position indicator?', choices: [choice('Dots', 'shots/q1.png'), choice('Counter', 'shots/q2.png')] },
  ],
} as unknown as InboxMessageWire;
const EARLIER = { id: M1, questions: [] } as unknown as InboxMessageWire;

// The thread's steps in thread order: an earlier message's image, then this message's text images in the order the text
// shows them (the second question's pictures first here, and D before B), then an attached file.
const today = step(image('att_today', 'shots/today.png', M1));
const q1 = step(image('att_q1', 'shots/q1.png', M2));
const q2 = step(image('att_q2', 'shots/q2.png', M2));
const d = step(image('att_d', 'shots/d.png', M2));
const a = step(image('att_a', 'shots/a.png', M2));
const b = step(image('att_b', 'shots/b.png', M2));
const attachedA = step(image('att_file_a', 'shots/a.png', M2), false);
const STEPS = [today, q1, q2, d, a, b, attachedA];

describe('option sets', () => {
  test('the zoom steps through that question\'s pictures only, in choice order, not the thread\'s order', () => {
    const set = optionSetOf([EARLIER, MESSAGE], STEPS, optionSetId(M2, 'q-design'))!;
    expect(set.steps.map((s) => s.attachment.id)).toEqual(['att_a', 'att_b', 'att_d']);
    // A choice without a picture is skipped, but each keeps its own letter.
    expect(set.choices.map((c) => [c.letter, c.label])).toEqual([
      ['A', 'Gmail-style ⋯'],
      ['B', 'Quiet hover menu'],
      ['D', 'Header menu only'],
    ]);
    expect(set.choices[0]!.recommended).toBe(true);
    expect(set.prompt).toBe('Which copy-message design should ship?');
    // The other question's pictures are a set of their own.
    expect(optionSetOf([EARLIER, MESSAGE], STEPS, optionSetId(M2, 'q-dots'))!.steps.map((s) => s.attachment.id)).toEqual(['att_q1', 'att_q2']);
  });

  test('an attached copy of a picture is not a choice; a picture seen twice is one step', () => {
    const set = optionSetOf([MESSAGE], [...STEPS, a], optionSetId(M2, 'q-design'))!;
    expect(set.steps.filter((s) => s.attachment.id === 'att_a')).toHaveLength(1);
    expect(set.steps.some((s) => s.attachment.id === 'att_file_a')).toBe(false);
  });

  test('no set: an unknown message or question, a malformed id, or one picture alone', () => {
    expect(optionSetOf([MESSAGE], STEPS, optionSetId('msg_other', 'q-design'))).toBeNull();
    expect(optionSetOf([MESSAGE], STEPS, optionSetId(M2, 'q-none'))).toBeNull();
    expect(optionSetOf([MESSAGE], STEPS, 'no-colon')).toBeNull();
    expect(optionSetOf([MESSAGE], STEPS, null)).toBeNull();
    // Only B captured so far: one picture is not a set (the viewer steps through the thread as before).
    expect(optionSetOf([MESSAGE], [today, b], optionSetId(M2, 'q-design'))).toBeNull();
  });

  test('the set id survives keys with colons (split at the first)', () => {
    expect(parseOptionSetId(optionSetId(M2, 'q:with:colons'))).toEqual({ messageId: M2, questionKey: 'q:with:colons' });
  });

  test('a file is found in the set by its id or its twin record', () => {
    const set = optionSetOf([MESSAGE], [today, a, { ...b, alsoIds: ['att_b_attached'] }, d], optionSetId(M2, 'q-design'))!;
    expect(optionOf(set, 'att_b_attached')?.choice.letter).toBe('B');
    expect(optionOf(set, 'att_today')).toBeNull();
  });

  test('labels lettered out of order keep their own letters in the caption, the announcement and the name', () => {
    const labels = ['C · The section is the folder', 'A · A tab', 'B · Header menu'];
    const message = { id: M2, questions: [{ key: 'q-order', prompt: 'Which?', choices: labels.map((label, i) => choice(label, `shots/${'cab'[i]}.png`)) }] } as unknown as InboxMessageWire;
    const steps = ['c', 'a', 'b'].map((x) => step(image(`att_${x}`, `shots/${x}.png`, M2)));
    const set = optionSetOf([message], steps, optionSetId(M2, 'q-order'))!;
    expect(set.choices.map((c) => c.letter)).toEqual(['C', 'A', 'B']);
    expect(set.choices.every((c) => c.lettered)).toBe(true);
    expect(optionAnnouncement(set, 0).startsWith('Option C of 3')).toBe(true);
    expect(choiceName('C · The section', 0, ['C · The section', 'A · x', 'B · y'])).toBe('C · The section');
  });

  test('mixed or repeated letters: unlabeled choices keep positions, and a clash makes the question use positions', () => {
    expect(choiceLetters(['C · x', 'plain', 'A · y']).map((c) => c.letter)).toEqual(['C', 'B', 'A']);
    expect(choiceLetters(['plain', 'B · y']).map((c) => c.lettered)).toEqual([false, true]);
    // Two labels both "A", or an unlabeled third choice next to a "C" label: no two choices share a letter.
    expect(choiceLetters(['A · one', 'A · two']).map((c) => c.letter)).toEqual(['A', 'B']);
    expect(choiceLetters(['C · x', 'plain', 'plain']).map((c) => c.letter)).toEqual(['A', 'B', 'C']);
    expect(choiceName('A · two', 1, ['A · one', 'A · two'])).toBe('B · A · two');
  });

  test('ordinary words that start with a capital and a dash or dot are not letters', () => {
    const letters = (labels: string[]) => choiceLetters(labels).map((c) => c.letter);
    const lettered = (labels: string[]) => choiceLetters(labels).map((c) => c.lettered);
    expect(letters(['X-axis', 'Y-axis', 'Both axes'])).toEqual(['A', 'B', 'C']);
    expect(lettered(['X-axis', 'Y-axis', 'Both axes'])).toEqual([false, false, false]);
    expect(lettered(['T-shirt sizes', 'E-mail', 'U-turn'])).toEqual([false, false, false]);
    expect(lettered(['U.S. only', 'A.I. summary', 'A–B test'])).toEqual([false, false, false]);
    // A Roman-numeral style label beyond the first n letters stays unlettered.
    expect(lettered(['I. Intro', 'Body', 'End'])).toEqual([false, false, false]);
    // Real forms still count.
    expect(lettered(['A. Tabs', 'B — Sidebar', 'C) Menu'])).toEqual([true, true, true]);
    expect(lettered(['A - x', 'B: y'])).toEqual([true, true]);
  });

  test('a label that already leads with its letter gets no second one', () => {
    expect(labelHasLetter('B · Total pinned', 'B')).toBe(true);
    expect(labelHasLetter('B) Tabs', 'B')).toBe(true);
    expect(labelHasLetter('B', 'B')).toBe(true);
    expect(labelHasLetter('Bold menu', 'B')).toBe(false);
    expect(labelHasLetter('A great idea', 'A')).toBe(false);
    expect(choiceName('Quiet hover menu', 1, ['A · Gmail', 'Quiet hover menu'])).toBe('B · Quiet hover menu');
    expect(choiceName('B · Total pinned', 1, ['Plain', 'B · Total pinned'])).toBe('B · Total pinned');
  });

  test('the caption\'s end line: at the last option, where the thread\'s other files are; at the first only after a swipe past it', () => {
    const set = optionSetOf([MESSAGE], STEPS, optionSetId(M2, 'q-design'))!;
    expect(optionEndLine(set, 2, 4, null)).toEqual({ note: LAST_OPTION_NOTE, others: 4 });
    expect(optionEndLine(set, 1, 4, null)).toBeNull();
    expect(optionEndLine(set, 0, 4, null)).toBeNull();
    expect(optionEndLine(set, 0, 4, FIRST_OPTION_NOTE)).toEqual({ note: FIRST_OPTION_NOTE, others: 0 });
    expect(optionAnnouncement(set, 0)).toBe('Option A of 3: Gmail-style ⋯, recommended');
    expect(optionAnnouncement(set, 2)).toBe('Option D of 3: Header menu only');
  });
});
