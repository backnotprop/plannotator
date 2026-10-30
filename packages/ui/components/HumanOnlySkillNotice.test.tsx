/**
 * What the human-only line says a skill's instructions go with: "your
 * feedback" by default (Plannotator's comments, unchanged), the host's word
 * when it sets one (the Inbox's comments ride "your reply"), and a
 * composer's own word over both. The failure this catches: an Inbox comment
 * promising the instructions go with "your feedback".
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const mod = (hasDom ? await import('./SkillReferenceMenu') : null) as typeof import('./SkillReferenceMenu') | null;

const SKILL = { name: 'readback', root: 'claude' as const, humanOnly: true };
let root: Root | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  mod!.resetSkillInstructionsDestination();
});

function line(props: { destination?: string } = {}): string {
  const host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host);
    const Notice = mod!.HumanOnlySkillNotice;
    root.render(<Notice skills={[SKILL]} {...props} />);
  });
  return host.textContent ?? '';
}

test.skipIf(!hasDom)('the default, the host word, and the composer word', () => {
  // Another suite in this process may have configured a host (the Inbox's App does at import).
  mod!.resetSkillInstructionsDestination();
  expect(line()).toContain('its instructions will be included with your feedback.');
  act(() => root?.unmount());
  mod!.setSkillInstructionsDestination('your reply');
  expect(line()).toContain('its instructions will be included with your reply.');
  act(() => root?.unmount());
  expect(line({ destination: 'your message' })).toContain('its instructions will be included with your message.');
});
