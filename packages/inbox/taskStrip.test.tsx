/**
 * The background-work strip: what the thread's agent
 * still runs in the background, above the reply box. The words for each task
 * (kind, how long it ran, "no output …" once it went quiet) are worked out
 * against the window's clock; the strip is not drawn while nothing runs; a
 * press shows a task's full description and command. The server's side is
 * proved by packages/server/inbox-bg-tasks.test.ts.
 *
 * The words run everywhere; the drawing is DOM-gated (DOM_TESTS=1, happy-dom).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TASK_QUIET_MS, TaskStrip, taskElapsed, taskStripItems, type InboxBgTask } from './parts/TaskStrip';

const hasDom = typeof document !== 'undefined';
const NOW = Date.UTC(2026, 10, 2, 12);
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const H = 3_600_000;

const agent: InboxBgTask = { id: 'a1', kind: 'agent', description: 'Build pin fix', agent_type: 'general-purpose', started_at: ago(4 * 60_000), last_output_at: ago(20_000) };
const stuck: InboxBgTask = { id: 'b1', kind: 'shell', description: 'Wait for test run', command: 'until grep -q done out.log; do :; done', started_at: ago(70 * H), last_output_at: ago(70 * H) };

describe('taskStripItems', () => {
  test('kind and elapsed; "no output" only once the task has been quiet past the threshold', () => {
    const items = taskStripItems([agent, stuck], NOW);
    expect(items.map((i) => `${i.label} (${i.facts})`)).toEqual(['Build pin fix (agent, 4 m)', 'Wait for test run (shell, 70 h, no output 70 h)']);
    expect(items.map((i) => i.quiet)).toEqual([false, true]);
    const edge = { ...agent, last_output_at: ago(TASK_QUIET_MS) };
    expect(taskStripItems([edge], NOW)[0]!.quiet).toBe(false);
    expect(taskStripItems([{ ...edge, last_output_at: ago(TASK_QUIET_MS + 1) }], NOW)[0]!.facts).toBe('agent, 4 m, no output 10 m');
  });

  test('a task with no description shows its command, else its id; no output yet counts from its start', () => {
    const bare: InboxBgTask = { id: 'm1', kind: 'monitor', description: '', command: 'tail -f log', started_at: ago(15 * 60_000), last_output_at: null };
    expect(taskStripItems([bare], NOW)[0]).toMatchObject({ label: 'tail -f log', facts: 'monitor, 15 m, no output 15 m' });
    expect(taskStripItems([{ ...bare, command: undefined, started_at: null }], NOW)[0]).toMatchObject({ label: 'm1', facts: 'monitor', quiet: false });
    expect(taskStripItems([stuck], NOW)[0]!.detail).toContain('$ until grep -q done out.log; do :; done');
    // A host that cannot tell when a task last wrote (no last_output_at) never has it called quiet.
    const unknown: InboxBgTask = { id: 'a7', kind: 'agent', description: 'Long review', started_at: ago(70 * H) };
    expect(taskStripItems([unknown], NOW)[0]).toMatchObject({ facts: 'agent, 70 h', quiet: false });
    expect(taskStripItems([unknown], NOW)[0]!.detail).not.toContain('output');
  });

  test('elapsed: minutes, hours under 100, then days', () => {
    expect([10_000, 4 * 60_000, 59 * 60_000, 70 * H, 99 * H, 100 * H].map(taskElapsed)).toEqual(['<1 m', '4 m', '59 m', '70 h', '99 h', '4 d']);
  });
});

describe.skipIf(!hasDom)('TaskStrip', () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  let savedNow: () => number;
  beforeEach(() => {
    savedNow = Date.now;
    Date.now = () => NOW;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    Date.now = savedNow;
  });

  const mount = async (tasks: InboxBgTask[], threadId = 'msg_A1') => {
    const asked: string[] = [];
    await act(async () => {
      root!.render(<TaskStrip threadId={threadId} pollMs={0} load={async (id) => (asked.push(id), { tasks })} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    return asked;
  };

  test('reads the thread\'s tasks; draws "N running" and each task; a press opens the full text', async () => {
    const asked = await mount([agent, stuck]);
    expect(asked).toEqual(['msg_A1']);
    const strip = host!.querySelector('[data-task-strip]')!;
    expect(strip.textContent).toBe('2 running' + 'Build pin fix (agent, 4 m)' + 'Wait for test run (shell, 70 h, no output 70 h)');
    const quiet = host!.querySelector<HTMLButtonElement>('[data-task="b1"]')!;
    expect(quiet.hasAttribute('data-quiet')).toBe(true);
    expect(quiet.title).toContain('Wait for test run');
    expect(host!.querySelector('[data-task-detail]')).toBeNull();
    act(() => quiet.click());
    expect(quiet.getAttribute('aria-expanded')).toBe('true');
    expect(host!.querySelector('[data-task-detail]')!.textContent).toContain('$ until grep -q done out.log; do :; done');
  });

  test('nothing while nothing runs, and a failed read draws nothing', async () => {
    await mount([]);
    expect(host!.innerHTML).toBe('');
    await act(async () => {
      root!.render(<TaskStrip threadId="msg_B2" pollMs={0} load={async () => Promise.reject(new Error('offline'))} />);
    });
    expect(host!.innerHTML).toBe('');
  });
});
