/**
 * A pull request handed to a new session (launch): the session starts in the
 * pull request's own project, as a live one must. Sending one to start in
 * another project would hand the PR to an agent working in the wrong
 * repository, so compose refuses it with the live rule's words; started in the
 * PR's project, the thread is handed the PR (`ComposeSent.pullKeys`).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { ComposeDialog } = (hasDom ? await import('./compose/ComposeDialog') : {}) as typeof import('./compose/ComposeDialog');

const AGENT = 'claude-code';
const PROJECTS = [
  { id: 'p1', name: 'billing', root: '/Users/me/work/billing', exists: true },
  { id: 'p2', name: 'api', root: '/Users/me/work/api', exists: true },
];
const PULLS = { keys: ['github.com/me/api#7'], projects: ['p2'], ask_line: 'Review it.' };

let root: Root | null = null;
let host: HTMLElement | null = null;
let starts: unknown[] = [];
let sent: { pullKeys?: readonly string[] | null; launched?: boolean }[] = [];

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  starts = [];
  sent = [];
});

const inDialog = (selector: string) => document.querySelector('dialog[data-compose]')!.querySelector<HTMLElement>(selector);

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** New message for the PR with the person looking at `current`, then "Claude Code New session" (it starts in `current`). */
async function startFrom(current: (typeof PROJECTS)[number]) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <ComposeDialog
        request={{ pulls: PULLS }}
        phone={false}
        current={{ id: current.id, root: current.root, name: current.name }}
        lastSent={null}
        home="/Users/me"
        onSent={(s) => sent.push(s)}
        onSaved={() => {}}
        onDeleted={() => {}}
        onClose={() => {}}
        transport={{
          sessions: async () => ({ serverSession: 's', home: '/Users/me', projects: [], launch: { agents: [{ agent: AGENT, name: 'Claude Code' }], projects: PROJECTS } }),
          startThread: async (input) => {
            starts.push(input.to);
            return { thread_id: 't1' };
          },
          drafts: false,
          uploads: false,
        }}
      />,
    );
  });
  await until(() => inDialog('button[data-compose-to]:not([data-loading])') !== null, 'To');
  act(() => inDialog('button[data-compose-to]')!.click());
  await until(() => inDialog(`[data-compose-start="${AGENT}"]`) !== null, 'the start row');
  act(() => inDialog(`[data-compose-start="${AGENT}"]`)!.click());
  await until(() => inDialog('[data-compose-to="start"]') !== null, 'To names the start');
  const text = inDialog('textarea') as HTMLTextAreaElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(text, 'Review it.');
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => inDialog('[data-compose-send]')!.click());
}

test.skipIf(!hasDom)("a new session in another project is refused, as a live one is: nothing starts", async () => {
  await startFrom(PROJECTS[0]!);
  await until(() => !!inDialog('[data-compose-error]')?.textContent, 'the error');
  expect(inDialog('[data-compose-error]')!.textContent).toContain("the pull request's agent works in its own project");
  expect(starts).toEqual([]);
  expect(sent).toEqual([]);
});

test.skipIf(!hasDom)("a new session in the pull request's project starts, and the thread is handed the pull request", async () => {
  await startFrom(PROJECTS[1]!);
  await until(() => sent.length === 1, 'the send');
  expect(starts).toEqual([{ launch: { agent: AGENT, project_id: 'p2' } }]);
  expect(sent[0]).toMatchObject({ pullKeys: PULLS.keys, launched: true });
});
