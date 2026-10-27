/**
 * Escape in an open file's full screen (the owner's note on PR #1958): one
 * thing per press, the innermost first, and only then does full screen end.
 * The order is pure and lives here; AttachmentPane reads the pane's state
 * into it and acts on the rung it names.
 *
 *  1. `popover`   ⋯ or the file list (the peek, a phone's sheet of files) closes.
 *  2. `composer`  a comment being written closes: a comment popover (text,
 *                 HTML pinpoint, code lines) or a diagram's composer. Typed
 *                 words are never lost: the pane asks first (the question
 *                 row), and only an empty composer just closes.
 *  3. `field`     the key came from the file's own comment row (an image's or
 *                 a film's): focus leaves the row, its words stay in it.
 *  4. `drawer`    the comments drawer (a phone's sheet) closes.
 *  4b. `linked`   a page the attached HTML page links to (not attached, shown
 *                 over it) steps back one page. Beside the thread too: the one
 *                 rung there, when the key came from inside the pane.
 *  5. `annotate`  an HTML file in Annotate goes to Interact (the pinpoint
 *                 hover goes with it), as it always has.
 *  6. `question`  the question about an unsaved comment goes away: keep writing.
 *  7. `leave`     full screen ends, back where it was opened from
 *                 (fullScreenOrigin.ts): beside the thread when the file was
 *                 beside it, else back to the thread (the file closes, through
 *                 the same unsaved-comment question), as always where it can
 *                 only be full screen (a phone, a narrow window).
 *
 * Beside the thread (not full screen) there is no ladder: each control keeps
 * its own Escape, as before.
 */

export type EscapeRung = 'popover' | 'composer' | 'field' | 'drawer' | 'linked' | 'annotate' | 'question' | 'leave';

/** The rungs in the order a press takes them. */
export const ESCAPE_LADDER: readonly EscapeRung[] = ['popover', 'composer', 'field', 'drawer', 'linked', 'annotate', 'question', 'leave'];

export interface EscapeLadderState {
  /** The file is full screen. */
  full: boolean;
  /** ⋯ or the file list is open. */
  popoverOpen: boolean;
  /** A comment popover or a diagram composer of the file is open. */
  composerOpen: boolean;
  /** The key came from the file's own comment row (an image's or a film's). */
  inField: boolean;
  /** The comments drawer (a phone's sheet) is open. */
  panelOpen: boolean;
  /** A page the attached HTML page links to is shown over it. */
  linkedOpen: boolean;
  /** An HTML file that takes comments is in Annotate. */
  annotating: boolean;
  /** The question about an unsaved comment is showing. */
  questionOpen: boolean;
}

export const IDLE_LADDER: EscapeLadderState = {
  full: true,
  popoverOpen: false,
  composerOpen: false,
  inField: false,
  panelOpen: false,
  linkedOpen: false,
  annotating: false,
  questionOpen: false,
};

/** What this Escape does, or null for nothing (beside the thread, with no linked page shown). */
export function escapeRung(state: EscapeLadderState): EscapeRung | null {
  if (!state.full) return state.linkedOpen ? 'linked' : null;
  if (state.popoverOpen) return 'popover';
  if (state.composerOpen) return 'composer';
  if (state.inField) return 'field';
  if (state.panelOpen) return 'drawer';
  if (state.linkedOpen) return 'linked';
  if (state.annotating) return 'annotate';
  if (state.questionOpen) return 'question';
  return 'leave';
}

/** The state a rung leaves behind once it has acted (the next press's starting point). */
export function afterRung(state: EscapeLadderState, rung: EscapeRung): EscapeLadderState {
  switch (rung) {
    case 'popover':
      return { ...state, popoverOpen: false };
    case 'composer':
      return { ...state, composerOpen: false };
    case 'field':
      return { ...state, inField: false };
    case 'drawer':
      return { ...state, panelOpen: false };
    case 'linked':
      // One page back; the walk counts it once (a stack of pages takes one press each).
      return { ...state, linkedOpen: false };
    case 'annotate':
      return { ...state, annotating: false };
    case 'question':
      return { ...state, questionOpen: false };
    case 'leave':
      return { ...state, full: false };
  }
}

/** Every press from `state` until full screen ends: the rungs in the order they act. */
export function walkLadder(state: EscapeLadderState): EscapeRung[] {
  const rungs: EscapeRung[] = [];
  let at = state;
  for (let guard = 0; guard < ESCAPE_LADDER.length; guard++) {
    const rung = escapeRung(at);
    if (!rung) break;
    rungs.push(rung);
    at = afterRung(at, rung);
  }
  return rungs;
}

/** The kinds of file the Inbox opens, as the ladder sees them. */
export type LadderFileKind = 'html' | 'markdown' | 'text' | 'code' | 'diagram' | 'image' | 'video' | 'download';

/**
 * Which rungs a kind of file can show: HTML is the only one with Annotate;
 * an image and a film have their own comment row and draw no popover; a
 * download takes no comments (its drawer lists other files' only).
 */
export function rungsFor(kind: LadderFileKind): readonly EscapeRung[] {
  switch (kind) {
    case 'html':
      return ['popover', 'composer', 'drawer', 'linked', 'annotate', 'question', 'leave'];
    case 'markdown':
    case 'text':
    case 'code':
    case 'diagram':
      return ['popover', 'composer', 'drawer', 'question', 'leave'];
    case 'image':
    case 'video':
      return ['popover', 'field', 'drawer', 'question', 'leave'];
    case 'download':
      return ['popover', 'drawer', 'leave'];
  }
}

/** Everything a kind can have open at once, for the walk in the tests and the docs. */
export function everythingOpen(kind: LadderFileKind): EscapeLadderState {
  const rungs = new Set(rungsFor(kind));
  return {
    full: true,
    popoverOpen: rungs.has('popover'),
    composerOpen: rungs.has('composer'),
    inField: rungs.has('field'),
    panelOpen: rungs.has('drawer'),
    linkedOpen: rungs.has('linked'),
    annotating: rungs.has('annotate'),
    questionOpen: rungs.has('question'),
  };
}
