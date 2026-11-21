/**
 * Where full screen goes back to (the owner's report, 2026-10-27): closing a
 * view returns to exactly the view that was showing before it opened, and
 * the browser's Back does the same.
 *
 * A thread shows a file in one of three frames: the thread alone, the file
 * beside the thread ("Side by side"), or the file full screen. Full screen is
 * entered three ways, and its way out (×, Escape's last rung) follows the way
 * in:
 *
 *  - From the thread alone (a tile, the image preview under a message, an
 *    image in the text, a question's picture, a link, a notification): × and
 *    Escape close the file and the thread is back as it was. Before this, they
 *    put the file beside the thread, a frame the person never opened.
 *  - With the view switch, from the file beside the thread (the header's Full
 *    screen): × and Escape put the file on screen back beside the thread, as
 *    before (a step inside full screen keeps the file it stepped to).
 *  - Another file opened full screen while one was beside the thread (a tile,
 *    a ⋯ Open full screen): × and Escape go back to the file that was beside.
 *
 * Side by side in full screen's toolbar, Write the reply and the toast's Undo
 * are not a way out: they ask for the file on screen beside the thread, from
 * whichever full screen.
 *
 * The history is the stack of frames. Entering full screen from beside the
 * thread is a new entry (it used to replace the entry, so Back skipped the
 * file beside the thread and went straight to the thread), and the entry
 * remembers how deep inside that full screen it is (`ibFullDepth`: 1, plus one
 * for each page pushed inside it: another version, a page the HTML file links
 * to, a file it links to) and whether the view switch entered it
 * (`ibFullSwitch`). Leaving for the side is then the browser's Back by that
 * many entries, onto the entry beside the thread, which takes the file on
 * screen now where the switch (or a pick) asks for it; no entry is left
 * behind to make a Back do nothing.
 *
 * The decisions are pure and live here; App.tsx runs the entry operation they
 * name, and fullScreenOrigin.test.ts checks every sequence of moves against
 * the stack of frames the person expects.
 */

/** The history-entry mark: how many entries this full screen is above the entry beside the thread it was entered from. */
export const FULL_DEPTH_STATE = 'ibFullDepth';
/** The history-entry mark: that full screen was entered with the view switch (the same file), not by opening another file. */
export const FULL_SWITCH_STATE = 'ibFullSwitch';
/** The history-entry mark on the switch's entry: the screen the entry beside the thread was opened from (a linked page's Back reaches past both). */
export const FULL_SIDE_FROM_STATE = 'ibSideFrom';
/** The history-entry mark of a full screen opened over another file beside the thread: that entry's screen, where × goes back to. */
export const FULL_OVER_STATE = 'ibFullOver';

/** A full screen entered from beside the thread, as an entry remembers it. */
export interface FullMark {
  /** Entries above the one beside the thread (1 for the full screen itself). */
  depth: number;
  /** Entered with the view switch: × keeps the file on screen beside the thread. */
  viaSwitch: boolean;
  /** On the switch's own entry: the screen the entry beside the thread under it was opened from. */
  sideFrom?: string;
  /** Opened over another file beside the thread (not the switch): the screen of the entry beside the thread, where × lands. */
  over?: string;
}

/** The mark an entry's `state` carries, or null (no full screen entered from beside the thread). */
export function fullMark(state: unknown): FullMark | null {
  const record = state && typeof state === 'object' ? (state as Record<string, unknown>) : null;
  const depth = record?.[FULL_DEPTH_STATE];
  if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 1) return null;
  const sideFrom = record![FULL_SIDE_FROM_STATE];
  const over = record![FULL_OVER_STATE];
  return {
    depth,
    viaSwitch: record![FULL_SWITCH_STATE] === true,
    ...(typeof sideFrom === 'string' ? { sideFrom } : {}),
    ...(typeof over === 'string' ? { over } : {}),
  };
}

/** The screen an entry was opened from (history.ts `ibFrom`), or null. */
function openedFrom(state: unknown): string | null {
  const from = state && typeof state === 'object' ? (state as Record<string, unknown>).ibFrom : undefined;
  return typeof from === 'string' ? from : null;
}

/** Whether the full screen on screen was entered from the file beside the thread. */
export function fullFromSide(state: unknown): boolean {
  return fullMark(state) !== null;
}

/** `state` with `mark` set (null drops it). */
export function withFullMark(state: unknown, mark: FullMark | null): Record<string, unknown> {
  const base = state && typeof state === 'object' ? { ...(state as Record<string, unknown>) } : {};
  delete base[FULL_DEPTH_STATE];
  delete base[FULL_SWITCH_STATE];
  delete base[FULL_SIDE_FROM_STATE];
  delete base[FULL_OVER_STATE];
  if (mark) {
    base[FULL_DEPTH_STATE] = mark.depth;
    if (mark.viaSwitch) base[FULL_SWITCH_STATE] = true;
    if (mark.sideFrom !== undefined) base[FULL_SIDE_FROM_STATE] = mark.sideFrom;
    if (mark.over !== undefined) base[FULL_OVER_STATE] = mark.over;
  }
  return base;
}

/**
 * What × and Escape's last rung do in full screen: back beside the thread when
 * it was entered from there; else close the file (the thread alone). Where the
 * file can only be full screen (a phone, a stacked window) they always close it.
 */
export function fullScreenExit(fromSide: boolean, locked: boolean): 'side' | 'close' {
  return !locked && fromSide ? 'side' : 'close';
}

/**
 * The file × and Escape's last rung go back to when it is another file than
 * the one on screen: a full screen opened over another file beside the
 * thread lands on that file (null: the switch keeps the file on screen, or no
 * full screen was entered from beside the thread). Leaving the file on
 * screen, they then ask first about a comment not saved yet, as a step or a
 * close does (AttachmentPane's `leave`).
 */
export function fullExitFile(state: unknown): string | null {
  const mark = fullMark(state);
  if (!mark || mark.viaSwitch || mark.over === undefined) return null;
  return new URLSearchParams(mark.over.replace(/^#/, '')).get('file');
}

/**
 * A move between frames the thread asks for:
 * - `switch-full`: the view switch takes the file beside the thread full screen;
 * - `open-full`: another file opens full screen while one is beside the thread;
 * - `exit-full`: × or Escape, in a full screen entered from beside the thread: back to it;
 * - `show-side`: the file on screen beside the thread (Side by side, Write the reply, Undo).
 */
export type FrameMove = 'switch-full' | 'open-full' | 'exit-full' | 'show-side';

/** The history entry on screen: its hash and its state. */
export interface EntryNow {
  hash: string;
  state: unknown;
}

/** What to do with the history to show a file. */
export type EntryOp =
  /** A new entry with its mark (null: none). */
  | { kind: 'push'; hash: string; mark: FullMark | null }
  /** Swap the entry on screen; `keep` keeps its mark, else `mark` replaces it. */
  | { kind: 'replace'; hash: string; keep: true }
  | { kind: 'replace'; hash: string; keep: false; mark: null }
  /** Back by `steps` entries, onto the entry beside the thread; then show `land` there (null: as it is). */
  | { kind: 'back'; steps: number; land: string | null };

/** The view a hash names for its file (`view=`), or null. */
function viewOf(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get('view');
}

/**
 * The entry for showing a file at `next`, from the entry on screen. A plain
 * open is a new entry (inside a full screen entered from beside the thread it
 * is one deeper); `replace` (a step, a comment card) swaps the entry on screen
 * and keeps its mark.
 */
export function fileEntryOp(now: EntryNow, next: string, request: { move?: FrameMove; replace?: boolean } = {}): EntryOp {
  const mark = fullMark(now.state);
  switch (request.move) {
    case 'switch-full': {
      const sideFrom = openedFrom(now.state);
      return { kind: 'push', hash: next, mark: { depth: 1, viaSwitch: true, ...(sideFrom !== null ? { sideFrom } : {}) } };
    }
    case 'open-full':
      return { kind: 'push', hash: next, mark: { depth: 1, viaSwitch: false, over: now.hash } };
    case 'exit-full':
    case 'show-side':
      // Back down to the entry beside the thread; a full screen not entered from there swaps in place, as before.
      if (!mark) return { kind: 'replace', hash: next, keep: false, mark: null };
      return { kind: 'back', steps: mark.depth, land: request.move === 'show-side' || mark.viaSwitch ? next : null };
  }
  if (request.replace) return { kind: 'replace', hash: next, keep: true };
  // A page pushed inside a full screen entered from beside the thread is one entry deeper in it.
  return {
    kind: 'push',
    hash: next,
    mark: mark && viewOf(next) === 'full' ? { depth: mark.depth + 1, viaSwitch: mark.viaSwitch, ...(mark.over !== undefined ? { over: mark.over } : {}) } : null,
  };
}

/**
 * A linked page's Back (the band over a page an attached HTML page links to)
 * in a full screen the switch entered on that page: the page it goes back to
 * is the entry under the page beside the thread, two entries down. The window
 * goes back there and takes it full screen again with the switch (a new entry
 * over it), so × and Back still come back beside the thread. `same` compares
 * screens whatever view they name (fileView.ts `sameScreenAnyView`).
 */
export function pageBackPastSwitch(now: EntryNow, target: string, same: (from: string, hash: string) => boolean): boolean {
  const mark = fullMark(now.state);
  return mark !== null && mark.viaSwitch && mark.depth === 1 && mark.sideFrom !== undefined && same(mark.sideFrom, target);
}
