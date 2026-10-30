/**
 * The skill references painted in a sent reply stop where the person's own
 * words end. A reply drawn in the person's words (sentReply.ts) no longer
 * shows the "## Answers to your questions" heading that used to end them, so
 * the answers list (the agent's prompts and choices) and the rest of the body
 * (the feedback, which quotes agent text) end them instead; and the feedback
 * on the agent's messages ("# Feedback on your messages") ends them like the
 * other feedback headings. The failure this catches: a `$name` an agent wrote
 * in a prompt, a choice or a quoted message painted as if the person typed it.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { expect, test } from 'bun:test';
import type { InboxSkillReference } from '@plannotator/core/skill-reference-block';
import { skillReferenceRanges } from './skillHighlight';

const hasDom = typeof document !== 'undefined';
const SKILLS: InboxSkillReference[] = [{ name: 'readback', humanOnly: false, included: false, bytes: 0 }];

function body(html: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'ib-body';
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}
const painted = (el: HTMLElement) => skillReferenceRanges(el, SKILLS).plain.map((r) => r.toString());

test.skipIf(!hasDom)('a sent reply: the words are painted, the answers list and the rest after it are not', () => {
  const el = body(
    '<div><p>Run $readback on it.</p></div>' +
      '<div data-sent-answers=""><ul><li><span>Q1</span> <span>Use $readback first?</span> <span>Yes, $readback</span></li></ul></div>' +
      '<div data-sent-rest=""><h2>notes.md</h2><blockquote>Quoted $readback</blockquote></div>',
  );
  expect(painted(el)).toEqual(['$readback']);
  el.remove();
});

test.skipIf(!hasDom)('answers alone, then feedback: nothing in the rest is painted', () => {
  const el = body('<div data-sent-rest=""><p>Also see $readback.</p></div>');
  expect(painted(el)).toEqual([]);
  el.remove();
});

test.skipIf(!hasDom)('"Feedback on your messages" ends the words like the other feedback headings', () => {
  const el = body('<p>Thanks, $readback it.</p><h1>Feedback on your messages</h1><blockquote>Your $readback note</blockquote>');
  expect(painted(el)).toEqual(['$readback']);
  el.remove();
});
