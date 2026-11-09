/**
 * A launch that clones first, on its run line (approval "launch-create-clone", E1-E11). Each case guards what the
 * person acts on: Cancel during the clone stops it on that machine (never Stop, which would read as the agent's);
 * git's percent shows with its bar only once there is one; a failed clone names the cause and the machine, keeps the
 * message, and offers the way out that fits it (Try again, Copy clone command, Change the URL); a cancelled clone
 * says nothing was kept and offers Clone again; a cloned repo that brings hooks waits for Trust and start; a name taken
 * since the pick is said under the line.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. Fetch is mocked: no server.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxRun } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { RunLine, cloneCommand } = (hasDom ? await import('./components/RunLine') : {}) as typeof import('./components/RunLine');

const MINI = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAW';
const CLONE = { url: 'git@github.com:acme/billing-api.git', host: 'github.com', slug: 'acme/billing-api', branch: null, pct: null, error: null, error_text: null, renamed_from: null, brings: null, folder_shown: '~/code/billing-api' };

function run(state: InboxRun['state'], clone: Partial<NonNullable<InboxRun['clone']>> = {}, extra: Partial<InboxRun> = {}): InboxRun {
  return { state, launch_id: 'lch_1', agent: 'claude-code', project: 'billing-api', folder: '/Users/mini/code/billing-api', since: null, again: false, stopped_by_person: false, cause: null, untrusted: false, attach_command: null, clone: { ...CLONE, ...clone }, ...extra } as InboxRun;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let posts: string[] = [];

beforeEach(() => {
  if (!hasDom) return;
  posts = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST') posts.push(String(input));
    return Response.json({ run: null });
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
});

function draw(line: InboxRun, props: { onChangeUrl?: (url: string) => void; machineName?: string | null } = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<RunLine run={line} canOpen={false} machine={MINI} machineName={props.machineName === undefined ? 'Mac mini' : props.machineName} onChanged={() => {}} onChangeUrl={props.onChangeUrl} />));
  return host;
}
const text = (el: HTMLElement) => el.querySelector('.ib-run-text')!.textContent;
const buttons = (el: HTMLElement) => [...el.querySelectorAll('button')].map((b) => b.textContent);

test.skipIf(!hasDom)('E1, E2: cloning names the repo and what starts next, with Cancel to that machine; the bar only with a percent', async () => {
  let el = draw(run('cloning'));
  expect(text(el)).toBe('Cloning acme/billing-api · Claude Code starts next');
  expect(el.querySelector('[data-run-clone-bar]')).toBeNull();
  expect(buttons(el)).toEqual(['Cancel']);
  await act(async () => (el.querySelector('[data-run-clone-cancel]') as HTMLButtonElement).click());
  expect(posts).toEqual([`/api/inbox/m/${MINI}/launch/lch_1/stop`]);
  act(() => root!.unmount());
  el = draw(run('cloning', { pct: 64 }));
  expect(text(el)).toBe('Cloning acme/billing-api · 64% · Claude Code starts next');
  expect((el.querySelector('[data-run-clone-bar] > i') as HTMLElement).style.width).toBe('64%');
});

test.skipIf(!hasDom)('E4, E5, E6: each failure names its cause and the machine, keeps the message, and offers its own way out', () => {
  let el = draw(run('clone_failed', { error: 'auth' }));
  expect(text(el)).toBe("Couldn't clone acme/billing-api. Mac mini isn't signed in to github.com. Your message is kept.Sign in to github.com on Mac mini, then try again.");
  expect(buttons(el)).toEqual(['Try again', 'Copy clone command']);
  act(() => root!.unmount());

  const asked: string[] = [];
  el = draw(run('clone_failed', { error: 'not_found' }), { onChangeUrl: (url) => asked.push(url) });
  expect(text(el)).toBe("Couldn't clone acme/billing-api. github.com has no such repo, or Mac mini can't see it. Your message is kept.");
  expect(buttons(el)).toEqual(['Change the URL', 'Try again']);
  act(() => (el.querySelector('[data-run-clone-change]') as HTMLButtonElement).click());
  expect(asked).toEqual([CLONE.url]);
  act(() => root!.unmount());

  el = draw(run('clone_failed', { error: 'network' }), { machineName: null });
  expect(text(el)).toBe("Couldn't reach github.com from this computer. Your message is kept.");
  expect(buttons(el)).toEqual(['Try again']);
});

test.skipIf(!hasDom)("Copy clone command is one command the person can run there: the branch, and a folder with a space quoted after ~/", () => {
  expect(cloneCommand({ url: CLONE.url, branch: null, folder_shown: '~/code/billing-api' })).toBe('git clone git@github.com:acme/billing-api.git ~/code/billing-api');
  expect(cloneCommand({ url: 'https://github.com/acme/billing-api.git', branch: 'release-2.1', folder_shown: '~/Documents/Client Work/billing-api' })).toBe(
    "git clone --branch release-2.1 https://github.com/acme/billing-api.git ~/'Documents/Client Work/billing-api'",
  );
});

test.skipIf(!hasDom)('E7: a cancelled clone says nothing was kept there, and Clone again clones again', async () => {
  const el = draw(run('clone_cancelled'));
  expect(text(el)).toBe('You cancelled the clone. Nothing was kept on Mac mini. Your reply starts it again.');
  expect(buttons(el)).toEqual(['Clone again']);
  await act(async () => (el.querySelector('[data-run-retry]') as HTMLButtonElement).click());
  expect(posts).toEqual([`/api/inbox/m/${MINI}/launch/lch_1/retry`]);
});

test.skipIf(!hasDom)('E10: a cloned repo that brings hooks waits for Trust and start; What\'s in it shows the reading', async () => {
  const el = draw(run('failed', { brings: ['hooks', 'MCP servers'] }, { untrusted: true, trust: { warning: 'This folder has 1 hook and 2 MCP servers.' } }));
  expect(text(el)).toBe('billing-api has its own hooks and MCP servers. Claude Code starts once you trust the folder.');
  expect(buttons(el)).toEqual(['Trust and start', "What's in it"]);
  act(() => (el.querySelector('[data-run-whats-in]') as HTMLButtonElement).click());
  expect(el.querySelector('[data-run-trust-warning]')!.textContent).toBe('This folder has 1 hook and 2 MCP servers.');
});

test.skipIf(!hasDom)('E11: a name taken since the pick is said under the starting line', () => {
  const el = draw(run('starting', { renamed_from: '~/code/billing-api', folder_shown: '~/code/billing-api-2' }, { project: 'billing-api-2' }));
  expect(text(el)).toBe('Starting Claude Code in billing-api-2…Cloned into ~/code/billing-api-2: billing-api was taken by then.');
});
