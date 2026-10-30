/**
 * The Inbox by keyboard, as a state machine (approval "inbox-keyboard-shortcuts"):
 * the approved behaviour of every key in every main view, written once. The
 * model test (model.test.ts) walks every key sequence up to a short length and
 * checks it has no dead end, never leaves focus on the page, and that no key
 * acts while the person types. The browser journeys
 * (tests/e2e/inbox-keyboard-journeys.spec.ts) compare the real window with it
 * after every key.
 *
 * It is the spec, not a copy of the code: where the window does something
 * else, one of the two is wrong and the test or the journey says which.
 */

/** Where keyboard focus is, as a kind of element (never a particular one). `body`: lost. */
export type Focus =
  | 'body'
  | 'row'
  | 'band'
  | 'message'
  | 'subject'
  | 'tile'
  | 'file'
  | 'reply-field'
  | 'reply-button'
  | 'search-field'
  | 'map'
  | 'settings-heading'
  | 'settings-field'
  | 'board-heading';

export type FileFrame = 'none' | 'side' | 'full';

export interface KeyState {
  page: 'inbox' | 'board' | 'settings';
  /** A thread open beside the list (inbox only). */
  thread: boolean;
  file: FileFrame;
  /** What had focus when a key opened the file (O, F from the thread): it has it again when the file closes. */
  fileReturn: Focus | null;
  /** Where full screen was entered from, so Escape goes back there (fullScreenOrigin.ts). */
  fullFrom: 'side' | 'thread' | null;
  /** The reply box is open. */
  box: boolean;
  /** Words kept as a draft (the foot says Edit draft). */
  draft: boolean;
  /** Overlays: the shortcut map and the search palette (each a modal, at most one). */
  overlay: 'none' | 'map' | 'search';
  /** Where focus goes back to when the overlay closes. */
  overlayReturn: Focus | null;
  /** Where Settings goes back to (Escape, ‹ Inbox). */
  settingsReturn: { page: 'inbox' | 'board'; thread: boolean; file: FileFrame; fullFrom: 'side' | 'thread' | null } | null;
  focus: Focus;
  /** Settings → General → Keyboard. */
  singleKeys: boolean;
  /** The remembered view a file opens in (O). F never changes it. */
  remembered: 'side' | 'full';
}

/** The keys the model knows. `type` is a printable character typed into whatever has focus. */
export type ModelKey =
  | 'Escape'
  | 'ArrowDown'
  | 'Enter'
  | 'R'
  | 'O'
  | 'F'
  | 'J'
  | 'Shift+J'
  | 'N'
  | '?'
  | '/'
  | 'G I'
  | 'G B'
  | 'G S'
  | 'Mod+K'
  | 'Mod+Enter'
  | 'type'
  | 'singleKeysOff'
  | 'singleKeysOn';

export const MODEL_KEYS: readonly ModelKey[] = ['Escape', 'ArrowDown', 'Enter', 'R', 'O', 'F', 'J', 'Shift+J', 'N', '?', '/', 'G I', 'G B', 'G S', 'Mod+K', 'Mod+Enter', 'type', 'singleKeysOff', 'singleKeysOn'];

/** The single keys (Single-key shortcuts turns them off): every model key that is one plain key or a sequence of them. */
export const MODEL_BARE_KEYS: readonly ModelKey[] = ['R', 'O', 'F', 'J', 'Shift+J', 'N', '?', '/', 'G I', 'G B', 'G S'];

export const START: KeyState = {
  page: 'inbox',
  thread: false,
  file: 'none',
  fullFrom: null,
  fileReturn: null,
  box: false,
  draft: false,
  overlay: 'none',
  overlayReturn: null,
  settingsReturn: null,
  focus: 'row',
  singleKeys: true,
  remembered: 'side',
};

const TEXT_FIELDS: ReadonlySet<Focus> = new Set(['reply-field', 'search-field', 'settings-field']);

/** Whether focus is a place to type: single keys are text there. */
export function typing(state: KeyState): boolean {
  return TEXT_FIELDS.has(state.focus);
}

/** How many layers Escape has to take off before the window is at a page's base (the list, the Board). */
export function depth(state: KeyState): number {
  return (
    (state.overlay !== 'none' ? 1 : 0) +
    (state.page === 'settings' ? 1 : 0) +
    (state.box ? 1 : 0) +
    (state.file === 'full' ? (state.fullFrom === 'side' ? 2 : 1) : state.file === 'side' ? 1 : 0) +
    (state.thread ? 1 : 0)
  );
}

/** The thread-pane focus after the file closes: where it was when a key opened the file, else its tile (focus fix 4). */
const afterFileCloses = (state: KeyState): KeyState => ({ ...state, file: 'none', fullFrom: null, fileReturn: null, focus: state.fileReturn ?? 'tile' });

/** What one key does. Unchanged state: the key does nothing there. */
export function press(state: KeyState, key: ModelKey): KeyState {
  // The settings switches are clicks in Settings in the window; here they stand for that change.
  if (key === 'singleKeysOff') return { ...state, singleKeys: false };
  if (key === 'singleKeysOn') return { ...state, singleKeys: true };

  // ⌘K opens search from anywhere, a field included; with the palette open it goes back to its field.
  if (key === 'Mod+K') {
    if (state.overlay === 'map') return state;
    if (state.overlay === 'search') return { ...state, focus: 'search-field' };
    return { ...state, overlay: 'search', overlayReturn: state.focus, focus: 'search-field' };
  }

  // A modal overlay keeps every key but its own.
  if (state.overlay === 'map') {
    if (key === 'Escape' || (key === '?' && state.singleKeys)) return { ...state, overlay: 'none', focus: state.overlayReturn ?? 'row', overlayReturn: null };
    return state;
  }
  if (state.overlay === 'search') {
    if (key === 'Escape') return { ...state, overlay: 'none', focus: state.overlayReturn ?? 'row', overlayReturn: null };
    // A result: its thread, focus on the matching message (a fresh thread: no file, no box).
    if (key === 'Enter') return { ...state, overlay: 'none', overlayReturn: null, page: 'inbox', thread: true, file: 'none', fullFrom: null, fileReturn: null, box: false, focus: 'message' };
    return state;
  }

  // In a text field every printable key is text.
  if (typing(state)) {
    if (state.focus === 'reply-field') {
      if (key === 'Mod+Enter') return { ...state, box: false, draft: false, focus: 'message' };
      if (key === 'Escape') return { ...state, box: false, draft: true, focus: 'reply-button' };
    }
    if (state.focus === 'settings-field' && key === 'Escape') return { ...state, focus: 'settings-heading' };
    return state;
  }

  if (key === 'type' || key === 'Mod+Enter') return state;
  const bare = (MODEL_BARE_KEYS as readonly string[]).includes(key);
  if (bare && !state.singleKeys) return state;

  switch (key) {
    case '?':
      return { ...state, overlay: 'map', overlayReturn: state.focus, focus: 'map' };
    case '/':
      return { ...state, overlay: 'search', overlayReturn: state.focus, focus: 'search-field' };
    case 'G I':
      if (state.page === 'inbox') return { ...state, focus: 'row' };
      return { ...state, page: 'inbox', thread: false, file: 'none', fullFrom: null, fileReturn: null, box: false, settingsReturn: null, focus: 'row' };
    case 'G B':
      return { ...state, page: 'board', thread: false, file: 'none', fullFrom: null, fileReturn: null, box: false, settingsReturn: null, focus: 'board-heading' };
    case 'G S':
      if (state.page === 'settings') return { ...state, focus: 'settings-heading' };
      return {
        ...state,
        page: 'settings',
        settingsReturn: { page: state.page as 'inbox' | 'board', thread: state.thread, file: state.file, fullFrom: state.fullFrom },
        box: false,
        focus: 'settings-heading',
      };
  }

  if (state.page === 'settings') {
    if (key === 'Escape') {
      const back = state.settingsReturn ?? { page: 'inbox' as const, thread: false, file: 'none' as const, fullFrom: null };
      const focus: Focus = back.page === 'board' ? 'board-heading' : back.file !== 'none' ? 'file' : back.thread ? 'row' : 'row';
      return { ...state, page: back.page, thread: back.thread, file: back.file, fullFrom: back.fullFrom, settingsReturn: null, focus };
    }
    // Tab into a field (the model's one way in): Enter on the heading stands for it.
    if (key === 'Enter') return { ...state, focus: 'settings-field' };
    return state;
  }

  if (state.page === 'board') {
    // The Board's own keys are its own (cards, panels); the model's are Escape-free at its base.
    return state;
  }

  // The inbox page.
  if (!state.thread) {
    // J (and K) with no thread open move along the rows as ↓ ↑ do: the next thread, nothing opened.
    if (key === 'ArrowDown' || (key === 'J' && (state.focus === 'row' || state.focus === 'band'))) return { ...state, focus: 'row' };
    if (key === 'Enter' && state.focus === 'row') return { ...state, thread: true, focus: 'row' };
    return state;
  }

  // A thread is open.
  const fromFile = state.focus === 'file';
  switch (key) {
    case 'Escape':
      if (state.file === 'full') {
        if (state.fullFrom === 'side') return { ...state, file: 'side', fullFrom: null, focus: 'file' };
        return afterFileCloses(state);
      }
      if (state.file === 'side') return afterFileCloses(state);
      return { ...state, thread: false, box: false, focus: 'row' };
    case 'ArrowDown':
      return state.focus === 'row' ? state : state;
    case 'Enter':
      // On a row: the thread is already open (another row: another thread; the model has one).
      return state;
    case 'J':
      // The next thread (approval "inbox-keyboard-shortcuts", J/K swap addendum 2026-10-27; K the previous one): as
      // Enter on its row, the list's order. Not from a file. From the list focus stays on the rows (on the new one);
      // from the thread it lands where N puts it. The reply box is the thread's: the new thread's starts closed.
      if (state.file !== 'none') return state;
      return { ...state, box: false, draft: false, focus: state.focus === 'row' || state.focus === 'band' ? 'row' : 'message' };
    case 'Shift+J':
    case 'N':
      // From the thread, or the list beside it (the readFromList extra); never from the file.
      if (fromFile || state.file === 'full') return state;
      return { ...state, focus: 'message' };
    case 'R':
      if (state.box) return { ...state, focus: 'reply-field' };
      // From full screen the file goes back beside the thread first (the strip's Write a reply).
      return { ...state, box: true, file: state.file === 'full' ? 'side' : state.file, fullFrom: null, focus: 'reply-field' };
    case 'O':
      if (fromFile) return state;
      return { ...state, file: state.remembered, fullFrom: state.remembered === 'full' ? 'thread' : null, fileReturn: state.file === 'none' ? state.focus : state.fileReturn, focus: 'file' };
    case 'F':
      if (state.file === 'none') return { ...state, file: 'full', fullFrom: 'thread', fileReturn: state.focus, focus: 'file' };
      if (state.file === 'side') return { ...state, file: 'full', fullFrom: 'side', focus: 'file' };
      return state.fullFrom === 'side' ? { ...state, file: 'side', fullFrom: null, focus: 'file' } : afterFileCloses(state);
  }
  return state;
}

/** Every state reachable from `start` in at most `maxKeys` presses, with one shortest path to each. */
export function explore(start: KeyState, maxKeys: number, keys: readonly ModelKey[] = MODEL_KEYS): Map<string, { state: KeyState; path: ModelKey[] }> {
  const seen = new Map<string, { state: KeyState; path: ModelKey[] }>([[JSON.stringify(start), { state: start, path: [] }]]);
  let frontier = [{ state: start, path: [] as ModelKey[] }];
  for (let n = 0; n < maxKeys; n++) {
    const next: typeof frontier = [];
    for (const { state, path } of frontier) {
      for (const key of keys) {
        const after = press(state, key);
        const id = JSON.stringify(after);
        if (seen.has(id)) continue;
        const entry = { state: after, path: [...path, key] };
        seen.set(id, entry);
        next.push(entry);
      }
    }
    frontier = next;
  }
  return seen;
}
