/**
 * Tidy's ⋮ menu and popover (components/Tidy.tsx). What this catches: a
 * finished run hiding new work (the menu stuck on "Tidy · 2/2" and the popover
 * on the old results, with no Tidy button, while new threads are owed); new
 * work hiding the run (an agent left unticked is still offered, and its
 * progress never showed again); a run's agent that changed nothing not reading
 * "Nothing to change", and one whose session ended before delivery not
 * reading "Session ended".
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxTidyPlan, InboxTidyRun } from '@plannotator/core/inbox-types';
import type { TidyController } from './components/Tidy';

const hasDom = typeof document !== 'undefined';
const { TidyMenu } = (hasDom ? await import('./components/Tidy') : {}) as typeof import('./components/Tidy');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const RUN: InboxTidyRun = {
  id: 'tdy_01M61900000000000000000000',
  at: new Date().toISOString(),
  agents: [
    { session: 'ses-a', host: 'claude-code', name: 'Claude Code', reach: 'wakes', state: 'tidied', updated: 1 },
    { session: 'ses-b', host: 'pi', name: 'Pi', reach: 'wakes', state: 'nothing', updated: 0 },
    { session: 'ses-d', host: 'opencode', name: 'OpenCode', reach: 'wakes', state: 'ended', updated: 0 },
  ],
  done: 3,
  updated: 1,
} as InboxTidyRun;

function plan(count: number): InboxTidyPlan {
  return {
    serverSession: 's',
    count,
    agents:
      count === 0
        ? []
        : [{ session: 'ses-c', host: 'codex', name: 'Codex', reach: 'wakes', items: [{ thread_id: 'msg_x', subject: 'Theme pass', project: { id: 'prj_x', name: 'herdr' }, reasons: ['you wrote last'] }] }],
    run: RUN,
  } as InboxTidyPlan;
}

const controller = (p: InboxTidyPlan): TidyController => ({ surface: 'list', scope: null, plan: p, run: p.run, start: async () => null, refresh: () => {} });

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

async function openMenu(tidy: TidyController) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<TidyMenu tidy={tidy} phone={false} className="ib-lhead-more" onRefresh={() => {}} />);
  });
  act(() => host!.querySelector<HTMLButtonElement>('[data-tidy-menu]')!.click());
  await settle();
  return host.querySelector<HTMLElement>('[data-tidy-item]')!;
}

test.skipIf(!hasDom)('new work and the run show together: the menu offers "Tidy N"; the popover the run, then the picker', async () => {
  const item = await openMenu(controller(plan(1)));
  expect(item.textContent).toBe('Tidy1');
  act(() => item.click());
  await settle();
  expect(document.querySelector('[data-tidy-go]')).not.toBeNull();
  expect(document.querySelector('[data-tidy-agent="ses-c"]')).not.toBeNull();
  expect(document.querySelectorAll('[data-tidy-run-agent]')).toHaveLength(3);
});

test.skipIf(!hasDom)('with nothing new offered the run shows alone: "Tidy · 3/3", "Nothing to change", "Session ended"', async () => {
  const item = await openMenu(controller(plan(0)));
  expect(item.textContent).toBe('Tidy · 3/3');
  act(() => item.click());
  await settle();
  expect(document.querySelector('[data-tidy-go]')).toBeNull();
  expect(document.querySelector('[data-tidy-run-agent="ses-b"]')!.textContent).toContain('Nothing to change');
  expect(document.querySelector('[data-tidy-run-agent="ses-a"]')!.textContent).toContain('1 thread updated');
  expect(document.querySelector('[data-tidy-run-agent="ses-d"]')!.textContent).toContain('Session ended');
});
