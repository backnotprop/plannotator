/**
 * The warning before a Mark read that sets questions aside (the owner's ask, 2026-11-10): what it counts and when it
 * asks (pure, always run), and under DOM_TESTS=1 (happy-dom, from tests/dom-test-list.txt) the dialog itself: Enter
 * goes on, Escape and Cancel change nothing, "Don't show this again" is passed on only when ticked, and a guest is not
 * offered it. The whole window over a real Inbox is packages/inbox/markReadWarningWindow.test.tsx (CI).
 *
 * What regresses: a warning on a Mark read that closes nothing, a Mark read that goes on after Cancel, a count that
 * disagrees with what the store closes, or a "Don't show this again" that is not kept.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { confirmSetAside, setAsideCount, type SetAsideAnswer, type SetAsideCount } from './markRead';

const hasDom = typeof document !== 'undefined';
const { MarkReadWarning } = (hasDom ? await import('./components/MarkReadWarning') : {}) as typeof import('./components/MarkReadWarning');

const questions = (over: Partial<InboxListRow['questions']> = {}) => ({ open: 0, picked: 0, stopped: false, holds_up: [], prompt: null, actions: 0, ...over }) as InboxListRow['questions'];

describe('setAsideCount: what a Mark read closes', () => {
  test('open questions, picks not sent and open action items count; a row with none counts nothing', () => {
    expect(setAsideCount([{ questions: questions() }])).toEqual({ questions: 0, actions: 0, threads: 0 });
    // `open` holds the action items: 3 open of which 1 is an action item, and 1 pick not sent.
    expect(setAsideCount([{ questions: questions({ open: 3, actions: 1, picked: 1 }) }])).toEqual({ questions: 3, actions: 1, threads: 1 });
  });

  test('across threads (Mark all as read): totals, and only the threads that hold any', () => {
    const rows = [{ questions: questions({ open: 2 }) }, { questions: questions() }, { questions: questions({ open: 1, actions: 1 }) }];
    expect(setAsideCount(rows)).toEqual({ questions: 2, actions: 1, threads: 2 });
  });

  test('a snoozed row is left out where the batch leaves it out', () => {
    const snoozed = { questions: questions({ open: 4 }), snoozed: { until: '2026-11-11T09:00:00Z', at: '2026-11-10T09:00:00Z' } as InboxListRow['snoozed'] };
    expect(setAsideCount([snoozed], { skipSnoozed: true })).toEqual({ questions: 0, actions: 0, threads: 0 });
    expect(setAsideCount([snoozed])).toEqual({ questions: 4, actions: 0, threads: 1 });
  });
});

describe('confirmSetAside: when the warning asks, and what each answer does', () => {
  const some: SetAsideCount = { questions: 2, actions: 0, threads: 1 };
  const none: SetAsideCount = { questions: 0, actions: 0, threads: 0 };
  const run = async (count: SetAsideCount, warnOn: boolean, answer: SetAsideAnswer) => {
    const asked: SetAsideCount[] = [];
    let turnedOff = 0;
    const go = await confirmSetAside(
      count,
      warnOn,
      async (c) => (asked.push(c), answer),
      () => turnedOff++,
    );
    return { go, asked, turnedOff };
  };

  test('nothing to set aside: no warning, the Mark read goes as before', async () => {
    expect(await run(none, true, { go: false })).toEqual({ go: true, asked: [], turnedOff: 0 });
  });

  test('the person turned it off: no warning', async () => {
    expect(await run(some, false, { go: false })).toEqual({ go: true, asked: [], turnedOff: 0 });
  });

  test('Cancel: no Mark read, and the warning stays on', async () => {
    expect(await run(some, true, { go: false })).toEqual({ go: false, asked: [some], turnedOff: 0 });
  });

  test('go on: the Mark read goes; with "Don\'t show this again" the warning is turned off first', async () => {
    expect(await run(some, true, { go: true, never: false })).toEqual({ go: true, asked: [some], turnedOff: 0 });
    expect(await run(some, true, { go: true, never: true })).toEqual({ go: true, asked: [some], turnedOff: 1 });
  });
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function show(props: { count?: SetAsideCount; bulk?: boolean; offerNever?: boolean }) {
  const answers: SetAsideAnswer[] = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <MarkReadWarning count={props.count ?? { questions: 2, actions: 0, threads: 1 }} bulk={props.bulk ?? false} offerNever={props.offerNever ?? true} onAnswer={(a) => answers.push(a)} />,
    );
  });
  const dialog = document.querySelector<HTMLElement>('[data-dialog="mark-read-warning"]')!;
  return { answers, dialog };
}

const key = (target: Element, k: string) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });

describe.skipIf(!hasDom)('the dialog', () => {
  test('opens with focus on the button that goes on; Enter goes on; nothing is turned off unless ticked', () => {
    const { answers, dialog } = show({});
    const go = dialog.querySelector<HTMLButtonElement>('[data-mark-read-warning-go]')!;
    expect(document.activeElement).toBe(go);
    expect(go.textContent).toBe('Mark read');
    // Enter from the checkbox (a button takes its own Enter natively).
    key(dialog.querySelector('input[type="checkbox"]')!, 'Enter');
    expect(answers).toEqual([{ go: true, never: false }]);
  });

  test('Escape and Cancel answer no', () => {
    const { answers, dialog } = show({});
    key(dialog.querySelector('h2')!, 'Escape');
    act(() => dialog.querySelector<HTMLButtonElement>('[data-mark-read-warning-cancel]')!.click());
    expect(answers).toEqual([{ go: false }, { go: false }]);
  });

  test('"Don\'t show this again", ticked, goes with the answer', () => {
    const { answers, dialog } = show({});
    act(() => dialog.querySelector<HTMLInputElement>('[data-mark-read-warning-never] input')!.click());
    act(() => dialog.querySelector<HTMLButtonElement>('[data-mark-read-warning-go]')!.click());
    expect(answers).toEqual([{ go: true, never: true }]);
  });

  test('a tailnet guest, who cannot save it, is not offered it', () => {
    const { dialog } = show({ offerNever: false });
    expect(dialog.querySelector('[data-mark-read-warning-never]')).toBeNull();
  });

  test('Mark all as read names the batch on its button', () => {
    const { dialog } = show({ bulk: true, count: { questions: 5, actions: 0, threads: 3 } });
    expect(dialog.querySelector('[data-mark-read-warning-go]')!.textContent).toBe('Mark all as read');
  });
});
