/**
 * A pull request handed to a new session (launch): the session starts in the
 * pull request's own project, as a live one must. To offers only that project,
 * whatever the person is looking at (the Pull requests page has no current
 * project), so the first choice is the right one and the thread is handed the
 * PR (`ComposeSent.pullKeys`). The failure this catches: To naming another
 * project, then Send refusing it.
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

/** New message for the PR with the person looking at `current` (null: the Pull requests page). */
async function open(current: (typeof PROJECTS)[number] | null, pulls: typeof PULLS = PULLS) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <ComposeDialog
        request={{ pulls }}
        phone={false}
        current={current ? { id: current.id, root: current.root, name: current.name } : null}
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
  await until(() => inDialog('[data-compose-to]:not([data-loading])') !== null, 'To');
}

/** "Claude Code New session", then Send with words. */
async function startAndSend() {
  act(() => inDialog('button[data-compose-to]')!.click());
  await until(() => inDialog(`[data-compose-start="${AGENT}"]`) !== null, 'the start row');
  act(() => inDialog(`[data-compose-start="${AGENT}"]`)!.click());
  await until(() => inDialog('[data-compose-to="start"]') !== null, 'To names the start');
  send();
}

function send() {
  const text = inDialog('textarea') as HTMLTextAreaElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(text, 'Review it.');
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => inDialog('[data-compose-send]')!.click());
}

for (const [where, current] of [
  ['from the Pull requests page (no current project)', null],
  ['while looking at another project', PROJECTS[0]!],
] as const) {
  test.skipIf(!hasDom)(`${where}: a new session starts in the pull request's project, and the thread is handed the pull request`, async () => {
    await open(current);
    await startAndSend();
    await until(() => sent.length === 1, 'the send');
    expect(starts).toEqual([{ launch: { agent: AGENT, project_id: 'p2' } }]);
    expect(sent[0]).toMatchObject({ pullKeys: PULLS.keys, launched: true });
  });
}

test.skipIf(!hasDom)("the folder menu offers only the pull request's project", async () => {
  await open(null);
  act(() => inDialog('button[data-compose-to]')!.click());
  await until(() => inDialog(`[data-compose-start="${AGENT}"]`) !== null, 'the start row');
  act(() => inDialog(`[data-compose-start="${AGENT}"]`)!.click());
  await until(() => inDialog('[data-compose-folder]') !== null, 'the folder button');
  act(() => inDialog('[data-compose-folder]')!.click());
  await until(() => inDialog('[data-compose-folder-option]') !== null, 'the menu');
  const rows = [...document.querySelectorAll('dialog[data-compose] [data-compose-folder-option]')].map((row) => row.getAttribute('data-compose-folder-option'));
  expect(rows).toEqual(['p2']);
});

test.skipIf(!hasDom)('a pull request with no project (a draft saved so): To says no agent is running, Send starts nothing, and the words can still be saved', async () => {
  await open(PROJECTS[0]!, { ...PULLS, projects: [] });
  expect(inDialog('[data-compose-to]')!.getAttribute('data-compose-to')).toBe('none');
  expect(inDialog('[data-compose-note="none"]')).not.toBeNull();
  send();
  await until(() => !!inDialog('[data-compose-error]')?.textContent, 'the error');
  expect(inDialog('[data-compose-error]')!.textContent).toContain('Save it as a draft');
  expect(starts).toEqual([]);
  expect((inDialog('textarea') as HTMLTextAreaElement).value).toBe('Review it.');
});
