/**
 * When a load may ask for the one-time list options dialog (approval "inbox-list-options-intro"). What regresses: the
 * dialog on the same load as the tour or another one-time dialog, over a reply or another dialog, on a page that is
 * not the Inbox's (Settings, the Board), over a search or a new message, through the tailnet, on a short list, or
 * before this load's other dialogs are decided; and, since the owner's note (2026-10-31, "it should show if I have a
 * thread open"), a thread open keeping it away.
 */
import { describe, expect, test } from 'bun:test';
import { LIST_INTRO_PREVIEW, listIntroMayAsk, listIntroPageClear, listIntroWanted, type ListIntroLoad } from './listIntro';
import { LIST_LOOK_OPTIONS } from './listLook';

const ready: ListIntroLoad = {
  due: true,
  local: true,
  listLoaded: true,
  firstRun: false,
  rows: 5,
  settled: true,
  tourThisLoad: false,
  otherDialogThisLoad: false,
  othersSettled: true,
  updating: false,
};
const calm = { modal: false, replying: false };

describe('the list options dialog: when a load may ask for it', () => {
  test('an existing user on the list, everything else decided: asks', () => {
    expect(listIntroWanted(ready)).toBe(true);
    expect(listIntroMayAsk(ready, calm)).toBe(true);
  });

  test('never on a load with the tour, the sound or the agent-note dialog: not even wanted, so nothing waits on it', () => {
    for (const load of [{ ...ready, tourThisLoad: true }, { ...ready, otherDialogThisLoad: true }]) {
      expect(listIntroWanted(load)).toBe(false);
      expect(listIntroMayAsk(load, calm)).toBe(false);
    }
  });

  test('not due (a new user, or already shown), through the tailnet, on first run or before the list loads: never', () => {
    for (const load of [{ ...ready, due: false }, { ...ready, local: false }, { ...ready, firstRun: true }, { ...ready, listLoaded: false }]) {
      expect(listIntroWanted(load)).toBe(false);
    }
  });

  test('a list of fewer than three rows waits for a later load', () => {
    expect(listIntroWanted({ ...ready, rows: 2 })).toBe(false);
    expect(listIntroWanted({ ...ready, rows: 3 })).toBe(true);
  });

  test('the Inbox page, a thread open or not (on a phone or a desktop); never Settings, the Board, a search or a new message', () => {
    const none = { search: false, compose: false };
    expect(listIntroPageClear({ page: 'inbox' }, none)).toBe(true);
    // A thread link, a notification, a reload on a thread: the thread is the Inbox page too (the owner, 2026-10-31).
    expect(listIntroPageClear({ page: 'inbox', thread: 'thr_1' } as { page: string }, none)).toBe(true);
    for (const page of ['settings', 'board', 'whats-new', 'tour', 'drafts']) expect(listIntroPageClear({ page }, none)).toBe(false);
    for (const thread of [null, 'thr_1']) {
      const route = { page: 'inbox', thread } as { page: string };
      expect(listIntroPageClear(route, { search: true, compose: false })).toBe(false);
      expect(listIntroPageClear(route, { search: false, compose: true })).toBe(false);
    }
  });

  test('wanted, but it waits: until the page has been settled a moment, before the other dialogs settle, over an update, another dialog or a reply', () => {
    expect(listIntroMayAsk({ ...ready, settled: false }, calm)).toBe(false);
    expect(listIntroMayAsk({ ...ready, othersSettled: false }, calm)).toBe(false);
    expect(listIntroMayAsk({ ...ready, updating: true }, calm)).toBe(false);
    expect(listIntroMayAsk(ready, { modal: true, replying: false })).toBe(false);
    expect(listIntroMayAsk(ready, { modal: false, replying: true })).toBe(false);
    // Still wanted meanwhile: the notification lines keep waiting for it.
    expect(listIntroWanted({ ...ready, settled: false, othersSettled: false, updating: true })).toBe(true);
  });

  test('the preview turns on every option of the ⋮ menu, in its order, then all off last', () => {
    const steps = LIST_INTRO_PREVIEW.map((step) => step.key);
    expect(steps).toEqual([...LIST_LOOK_OPTIONS.map((option) => option.key), null]);
    const at = LIST_INTRO_PREVIEW.map((step) => step.at);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
});
