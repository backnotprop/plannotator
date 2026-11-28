/**
 * The quiet note a Tidy or a Combine leaves in a thread (components/Tidy.tsx `TidyNote`; approval
 * "inbox-combine-across-computers": a Combine is not a Tidy). What regresses: a Combine's wake note, in a picked thread
 * or in the chosen agent's own last thread when every pick is on the other computer, reading "Tidy sent to …".
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { TidyNote } = (hasDom ? await import('./components/Tidy') : {}) as typeof import('./components/Tidy');

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

const noteFor = (run: string) => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<TidyNote run={run} agent="Claude Code" time="8:54 AM" fullWhen="Nov 22, 2026, 8:54 AM" />));
  return host.querySelector('[data-tidy-note]')!.textContent;
};

test.skipIf(!hasDom)("a Combine's note says Combine, a Tidy's says Tidy", () => {
  expect(noteFor('cmb_01M80000000000000000000009')).toBe('Combine sent to Claude Code · 8:54 AM');
  act(() => root!.unmount());
  host!.remove();
  expect(noteFor('tdy_01M80000000000000000000009')).toBe('Tidy sent to Claude Code · 8:54 AM');
});
