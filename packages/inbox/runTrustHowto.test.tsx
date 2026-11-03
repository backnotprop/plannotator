/**
 * The run line's trust how-to (`data-run-trust-howto`), shown when a launch failed on an untrusted folder
 * and no Trust folder button can be offered. It shows only the sentence that is true for the folder (the
 * owner, q-aa43fc24 A): the home folder can never be trusted, so telling the person to run the agent there
 * would be wrong; anywhere else, running the agent there is the way. The failure this catches: both
 * sentences shown together, or the wrong one for the folder, or another agent named as Claude Code.
 *
 * The two sentences are pinned on purpose: the owner chose their exact words.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxRun } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { RunLine } = (hasDom ? await import('./components/RunLine') : {}) as typeof import('./components/RunLine');

const HOME = "Your home folder can't be trusted. Start in a folder inside it.";
const elsewhere = (name: string) => `To trust it, run ${name} here in a terminal on the Inbox's computer.`;

function failedUntrusted(extra: Omit<Partial<InboxRun>, 'agent'> & { agent?: string } = {}): InboxRun {
  return {
    state: 'failed',
    launch_id: 'lch_1',
    agent: 'claude-code',
    project: 'ledger',
    folder: '/work/ledger',
    since: null,
    again: false,
    stopped_by_person: false,
    cause: "~/work/ledger isn't a trusted folder yet.",
    untrusted: true,
    attach_command: null,
    ...extra,
  } as InboxRun;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function howto(run: InboxRun): string | null {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<RunLine run={run} canOpen={false} onChanged={() => {}} />));
  return host.querySelector('[data-run-trust-howto]')?.textContent ?? null;
}

test.skipIf(!hasDom)('the home folder: only the sentence that says it cannot be trusted', () => {
  expect(howto(failedUntrusted({ folder: '/Users/me', home_folder: true }))).toBe(HOME);
});

test.skipIf(!hasDom)("any other folder: only the sentence that says to run the agent there, in that agent's name", () => {
  expect(howto(failedUntrusted())).toBe(elsewhere('Claude Code'));
  act(() => root?.unmount());
  host?.remove();
  expect(howto(failedUntrusted({ agent: 'opencode' }))).toBe(elsewhere('OpenCode'));
});
