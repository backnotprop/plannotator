/**
 * When a load may ask for "Choose how your list looks" (approval "inbox-rows-dialog"; first "inbox-list-options-intro"),
 * and the demo it plays. What regresses: the
 * dialog on the same load as the tour or another one-time dialog, over a reply or another dialog, on a page that is
 * not the Inbox's (Settings, the Board), over a file, document, guided review or Artifacts view (side by side or full
 * screen), over a search or a new message, through the tailnet, on a short list, or before this load's other dialogs
 * are decided; and, since the owner's note (2026-10-31, "it should show if I have a thread open"), a thread open
 * keeping it away; a list under five threads bringing it up (q-2c590791); and the demo's moments drifting from the
 * approved timeline (letters 0.3 s, logos 0.9 s, the turn 1.5 s, back with the notes card 2.2 s, held 2.6 s).
 */
import { describe, expect, test } from 'bun:test';
import { LIST_INTRO_MIN_ROWS, ROWS_INTRO_END_MS, listIntroMayAsk, listIntroPageClear, listIntroWanted, rowsIntroScene, type ListIntroLoad } from './listIntro';

const ready: ListIntroLoad = {
  due: true,
  owner: true,
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

  test("not due (a new user, or already shown), on a tailnet guest's page, on first run or before the list loads: never", () => {
    for (const load of [{ ...ready, due: false }, { ...ready, owner: false }, { ...ready, firstRun: true }, { ...ready, listLoaded: false }]) {
      expect(listIntroWanted(load)).toBe(false);
    }
  });

  test('a list of fewer than five threads waits for a later load; five or more asks', () => {
    expect(LIST_INTRO_MIN_ROWS).toBe(5);
    for (const rows of [0, 3, 4]) expect(listIntroWanted({ ...ready, rows })).toBe(false);
    for (const rows of [5, 40]) expect(listIntroWanted({ ...ready, rows })).toBe(true);
  });

  test('the Inbox page, a thread open or not (on a phone or a desktop); never Settings, the Board, a search or a new message', () => {
    const none = { search: false, compose: false };
    expect(listIntroPageClear({ page: 'inbox' }, none)).toBe(true);
    // A thread link, a notification, a reload on a thread: the thread is the Inbox page too (the owner, 2026-10-31).
    const onThread = { page: 'inbox', thread: 'thr_1', file: null, guide: null, artifacts: false };
    expect(listIntroPageClear(onThread, none)).toBe(true);
    for (const page of ['settings', 'board', 'whats-new', 'tour', 'drafts']) expect(listIntroPageClear({ page }, none)).toBe(false);
    for (const thread of [null, 'thr_1']) {
      const route = { page: 'inbox', thread };
      expect(listIntroPageClear(route, { search: true, compose: false })).toBe(false);
      expect(listIntroPageClear(route, { search: false, compose: true })).toBe(false);
    }
  });

  test('never over a file, document, guided review or Artifacts view on the thread, side by side or full screen', () => {
    const none = { search: false, compose: false };
    const onThread = { page: 'inbox', thread: 'thr_1', file: null, guide: null, artifacts: false };
    for (const view of ['side', 'full', null] as const) {
      // A file or a document (both are attachments), in either view or the remembered one.
      expect(listIntroPageClear({ ...onThread, file: { id: 'att_1', version: 'current', focus: null, view } }, none)).toBe(false);
    }
    expect(listIntroPageClear({ ...onThread, guide: 'msg_1' }, none)).toBe(false);
    expect(listIntroPageClear({ ...onThread, artifacts: true }, none)).toBe(false);
    // Closed again: the thread alone is clear.
    expect(listIntroPageClear(onThread, none)).toBe(true);
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

  test('the demo: no marks, then letters, logos, the turn to the projects, back to the stacked look with the notes card, then it holds', () => {
    const at = (t: number) => rowsIntroScene(t);
    expect(at(0)).toEqual({ marks: 'off', logos: false, card: false, held: false });
    expect(at(299).marks).toBe('off');
    expect(at(300)).toEqual({ marks: 'both', logos: false, card: false, held: false });
    expect(at(900)).toEqual({ marks: 'both', logos: true, card: false, held: false });
    expect(at(1500)).toEqual({ marks: 'projects', logos: true, card: false, held: false });
    expect(at(2200)).toEqual({ marks: 'both', logos: true, card: true, held: false });
    // It ends on the stacked look and holds it: no Inline flip, no reset afterwards.
    expect(ROWS_INTRO_END_MS).toBe(2600);
    for (const t of [2600, 5000, 60_000]) expect(at(t)).toEqual({ marks: 'both', logos: true, card: true, held: true });
  });
});
