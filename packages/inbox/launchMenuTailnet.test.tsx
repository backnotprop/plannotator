/**
 * A launched thread on the owner's page over the tailnet: Stop and Delete in its ⋯, Stop on its run line, and Try
 * again when it failed, as on this computer (owner ruling 2026-11-11).
 *
 * The failure this catches: the owner over the tailnet losing Stop, Delete or Try again.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxRun, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'app-abcdef', name: 'app', root: '/work/app', created_at: '2026-10-20T09:00:00.000Z' };
const PERSON = { kind: 'person' } as InboxAuthor;
const ROOT = 'msg_L1';

const LAUNCHED: InboxThread = {
  thread_id: ROOT,
  project: PROJECT,
  subject: 'Fix the build',
  thread_name: null,
  resolved_at: null,
  messages: [
    {
      id: ROOT,
      project_id: PROJECT.id,
      thread_id: ROOT,
      reply_to: null,
      author: PERSON,
      to: { host: 'claude-code', session: 'sess-a' },
      subject: 'Fix the build',
      subject_question: null,
      body: 'Fix the build.',
      created_at: '2026-10-20T18:10:00.000Z',
      resolved_at: null,
      idempotency_key: 'k-a',
      launch: { id: 'lch_a', agent: 'claude-code', session_ref: 'sa', folder: '/work/app', scratch: false, started_at: '2026-10-20T18:10:00.000Z' },
    } as InboxMessageWire,
  ],
};

let root: Root | null = null;
let host: HTMLElement | null = null;
const restore: (() => void)[] = [];

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  for (const undo of restore.splice(0).reverse()) undo();
});

async function until(check: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function press(el: Element) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    (el as HTMLElement).click();
  });
}

/** Draws the launched thread on the owner's page over the tailnet, with `run` as its run line. */
async function draw(run: InboxRun | null) {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL) => Response.json({})) as typeof fetch;
  restore.push(() => {
    globalThis.fetch = savedFetch;
  });
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <ThreadPane
        thread={LAUNCHED}
        sent={null}
        onQuestions={() => {}}
        onChanged={async () => {}}
        onClose={() => {}}
        file={null}
        onOpenFile={() => {}}
        onOpenGuide={() => {}}
        run={run}
        remote={true}
      />,
    );
  });
  await until(() => !!host!.querySelector('[data-thread-more]'), 'the ⋯ button');
}

function undraw() {
  act(() => root!.unmount());
  host!.remove();
  root = null;
  host = null;
}

/** The launch items of the open thread's ⋯ (`data-launch-item`), top to bottom. A resting agent (no run line): the owner's ⋯ offers Stop then too. */
async function launchItems(): Promise<string[]> {
  await draw(null);
  await press(host!.querySelector('[data-thread-more]')!);
  await until(() => !!document.querySelector('[data-thread-menu]'), 'the ⋯ menu');
  const items = [...document.querySelectorAll('[data-thread-menu] [data-launch-item]')].map((el) => el.getAttribute('data-launch-item')!);
  undraw();
  return items;
}

test.skipIf(!hasDom)("the owner's ⋯ over the tailnet has Stop and Delete for a launched agent", async () => {
  expect(await launchItems()).toEqual(['stop', 'delete']);
});

const runOf = (over: Partial<InboxRun>): InboxRun =>
  ({ state: 'working', launch_id: 'lch_a', agent: 'claude-code', project: 'app', folder: '/work/app', since: '2026-10-20T18:10:00.000Z', again: false, stopped_by_person: false, cause: null, untrusted: false, attach_command: null, ...over }) as InboxRun;

/** The run line's Stop and Try again (`data-run-stop`, `data-run-retry`) on the drawn page. */
async function runButtons(run: InboxRun): Promise<string[]> {
  await draw(run);
  await until(() => !!host!.querySelector('[data-run]'), 'the run line');
  const buttons = [...host!.querySelectorAll('[data-run-stop], [data-run-retry]')].map((el) => (el.hasAttribute('data-run-stop') ? 'stop' : 'retry'));
  undraw();
  return buttons;
}

test.skipIf(!hasDom)("the owner's run line over the tailnet has Stop (working, or waiting on a prompt) and Try again (failed)", async () => {
  expect(await runButtons(runOf({ state: 'working' }))).toEqual(['stop']);
  expect(await runButtons(runOf({ state: 'waiting_terminal' }))).toEqual(['stop']);
  expect(await runButtons(runOf({ state: 'failed', cause: 'Claude Code exited.' }))).toEqual(['retry']);
});

/** The stopped run line's words on the drawn page. */
async function stoppedLine(): Promise<string> {
  await draw(runOf({ state: 'stopped', stopped_by_person: true }));
  await until(() => !!host!.querySelector('[data-run="stopped"]'), 'the stopped line');
  const text = host!.querySelector('[data-run="stopped"] .ib-run-text')!.textContent ?? '';
  undraw();
  return text;
}

test.skipIf(!hasDom)("a stopped session: the line says a reply starts it again", async () => {
  expect(await stoppedLine()).toContain('Your reply starts it again.');
});
