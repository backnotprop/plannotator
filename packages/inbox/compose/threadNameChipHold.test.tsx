/**
 * The thread chip while it has focus (ThreadNameChip): compose works its suggestion out a moment after typing stops,
 * so a suggestion can arrive after the person moved into the chip. It must not land under the caret: there it joins
 * the words being typed ("Quiet section" + "Promo field" sent as one name). What this catches: the chip refilling
 * with a newer suggestion while focused, or not following the message again once focus leaves.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ThreadNameState } from './model';

const hasDom = typeof document !== 'undefined';
const { ThreadNameChip } = (hasDom ? await import('./ThreadNameChip') : {}) as typeof import('./ThreadNameChip');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function draw(suggested: string, state: ThreadNameState = { typed: '', edited: false }) {
  act(() => root!.render(<ThreadNameChip state={state} suggested={suggested} onChange={() => {}} onDone={() => {}} onOverflow={() => {}} idBase="t" />));
}

test.if(hasDom)('a suggestion that arrives while the chip has focus waits; focus leaving follows the message again', () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  draw('');
  const input = host.querySelector('input')!;
  act(() => input.focus());
  draw('Quiet section');
  expect(input.value).toBe('');
  act(() => input.blur());
  expect(input.value).toBe('Quiet section');
  // Not focused: it follows each new suggestion.
  draw('Promo field');
  expect(input.value).toBe('Promo field');
});
