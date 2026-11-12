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
  | 'board-heading'
  | 'reviews-heading'
  | 'drafts-heading'
  | 'artifacts-heading'
  | 'artifacts-button'
  | 'compose-field'
  | 'snooze-menu';

type BasePage = 'inbox' | 'board' | 'reviews' | 'drafts';

export type FileFrame = 'none' | 'side' | 'full';

export interface KeyState {
  page: BasePage | 'settings';
  thread: boolean;
  artifacts: boolean;
  file: FileFrame;
  fileReturn: Focus | null;
  fullFrom: 'side' | 'thread' | null;
  box: boolean;
  draft: boolean;
  overlay: 'none' | 'map' | 'search' | 'compose' | 'snooze';
  overlayReturn: Focus | null;
  settingsReturn: { page: BasePage; thread: boolean; artifacts: boolean; file: FileFrame; fullFrom: 'side' | 'thread' | null } | null;
  focus: Focus;
  singleKeys: boolean;
  remembered: 'side' | 'full';
}

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
  | 'G P'
  | 'G D'
  | 'Shift+O'
  | 'H'
  | 'C'
  | 'Mod+K'
  | 'Mod+Enter'
  | 'type'
  | 'singleKeysOff'
  | 'singleKeysOn';

export const MODEL_KEYS: readonly ModelKey[] = ['Escape', 'ArrowDown', 'Enter', 'R', 'O', 'F', 'J', 'Shift+J', 'N', 'Shift+O', 'H', 'C', '?', '/', 'G I', 'G B', 'G S', 'G P', 'G D', 'Mod+K', 'Mod+Enter', 'type', 'singleKeysOff', 'singleKeysOn'];

export const MODEL_BARE_KEYS: readonly ModelKey[] = ['R', 'O', 'F', 'J', 'Shift+J', 'N', 'Shift+O', 'H', 'C', '?', '/', 'G I', 'G B', 'G S', 'G P', 'G D'];

export const START: KeyState = {
  page: 'inbox',
  thread: false,
  artifacts: false,
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

const TEXT_FIELDS: ReadonlySet<Focus> = new Set(['reply-field', 'search-field', 'settings-field', 'compose-field']);

const HEADING: Record<Exclude<BasePage, 'inbox'>, Focus> = { board: 'board-heading', reviews: 'reviews-heading', drafts: 'drafts-heading' };

export function typing(state: KeyState): boolean {
  return TEXT_FIELDS.has(state.focus);
}

export function depth(state: KeyState): number {
  return (
    (state.overlay !== 'none' ? 1 : 0) +
    (state.page === 'settings' ? 1 : 0) +
    (state.box ? 1 : 0) +
    (state.file === 'full' ? (state.fullFrom === 'side' ? 2 : 1) : state.file === 'side' ? 1 : 0) +
    (state.artifacts ? 1 : 0) +
    (state.thread ? 1 : 0)
  );
}

const afterFileCloses = (state: KeyState): KeyState => ({ ...state, file: 'none', fullFrom: null, fileReturn: null, focus: state.fileReturn ?? 'tile' });

export function press(state: KeyState, key: ModelKey): KeyState {
  if (key === 'singleKeysOff') return { ...state, singleKeys: false };
  if (key === 'singleKeysOn') return { ...state, singleKeys: true };

  if (key === 'Mod+K') {
    if (state.overlay === 'map' || state.overlay === 'compose' || state.overlay === 'snooze') return state;
    if (state.overlay === 'search') return { ...state, focus: 'search-field' };
    return { ...state, overlay: 'search', overlayReturn: state.focus, focus: 'search-field' };
  }

  if (state.overlay === 'map') {
    if (key === 'Escape' || (key === '?' && state.singleKeys)) return { ...state, overlay: 'none', focus: state.overlayReturn ?? 'row', overlayReturn: null };
    return state;
  }
  if (state.overlay === 'compose' || state.overlay === 'snooze') {
    if (key === 'Escape') return { ...state, overlay: 'none', focus: state.overlayReturn ?? 'row', overlayReturn: null };
    return state;
  }
  if (state.overlay === 'search') {
    if (key === 'Escape') return { ...state, overlay: 'none', focus: state.overlayReturn ?? 'row', overlayReturn: null };
    if (key === 'Enter') return { ...state, overlay: 'none', overlayReturn: null, page: 'inbox', thread: true, artifacts: false, file: 'none', fullFrom: null, fileReturn: null, box: false, focus: 'message' };
    return state;
  }

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
    case 'C':
      return { ...state, overlay: 'compose', overlayReturn: state.focus, focus: 'compose-field' };
    case 'G I':
      if (state.page === 'inbox') return { ...state, focus: 'row' };
      return { ...state, page: 'inbox', thread: false, artifacts: false, file: 'none', fullFrom: null, fileReturn: null, box: false, settingsReturn: null, focus: 'row' };
    case 'G B':
    case 'G P':
    case 'G D': {
      const page = key === 'G B' ? 'board' : key === 'G P' ? 'reviews' : 'drafts';
      return { ...state, page, thread: false, artifacts: false, file: 'none', fullFrom: null, fileReturn: null, box: false, settingsReturn: null, focus: HEADING[page] };
    }
    case 'G S':
      if (state.page === 'settings') return { ...state, focus: 'settings-heading' };
      return {
        ...state,
        page: 'settings',
        settingsReturn: { page: state.page, thread: state.thread, artifacts: state.artifacts, file: state.file, fullFrom: state.fullFrom },
        box: false,
        focus: 'settings-heading',
      };
  }

  if (state.page === 'settings') {
    if (key === 'Escape') {
      const back = state.settingsReturn ?? { page: 'inbox' as const, thread: false, artifacts: false, file: 'none' as const, fullFrom: null };
      const focus: Focus = back.page !== 'inbox' ? HEADING[back.page] : back.file !== 'none' ? 'file' : back.thread ? 'row' : 'row';
      return { ...state, page: back.page, thread: back.thread, artifacts: back.artifacts, file: back.file, fullFrom: back.fullFrom, settingsReturn: null, focus };
    }
    if (key === 'Enter') return { ...state, focus: 'settings-field' };
    return state;
  }

  if (state.page !== 'inbox') {
    return state;
  }

  if (key === 'H' && state.focus === 'row') return { ...state, overlay: 'snooze', overlayReturn: state.focus, focus: 'snooze-menu' };
  if (!state.thread) {
    if (key === 'ArrowDown' || (key === 'J' && (state.focus === 'row' || state.focus === 'band'))) return { ...state, focus: 'row' };
    if (key === 'Enter' && state.focus === 'row') return { ...state, thread: true, focus: 'row' };
    return state;
  }

  const fromFile = state.focus === 'file';
  switch (key) {
    case 'Escape':
      if (state.file === 'full') {
        if (state.fullFrom === 'side') return { ...state, file: 'side', fullFrom: null, focus: 'file' };
        return afterFileCloses(state);
      }
      if (state.file === 'side') return afterFileCloses(state);
      if (state.artifacts) return { ...state, artifacts: false, focus: 'artifacts-button' };
      return { ...state, thread: false, box: false, focus: 'row' };
    case 'Shift+O':
      if (fromFile || state.file === 'full') return state;
      return state.artifacts ? { ...state, artifacts: false, focus: 'artifacts-button' } : { ...state, artifacts: true, focus: 'artifacts-heading' };
    case 'H':
      if (fromFile || state.file === 'full') return state;
      return { ...state, overlay: 'snooze', overlayReturn: state.focus, focus: 'snooze-menu' };
  }
  if (state.artifacts && (key === 'J' || key === 'Shift+J' || key === 'N' || key === 'O' || key === 'F')) return state;
  switch (key) {
    case 'ArrowDown':
      return state.focus === 'row' ? state : state;
    case 'Enter':
      return state;
    case 'J':
      if (state.file !== 'none') return state;
      return { ...state, box: false, draft: false, focus: state.focus === 'row' || state.focus === 'band' ? 'row' : 'message' };
    case 'Shift+J':
    case 'N':
      if (fromFile || state.file === 'full') return state;
      return { ...state, focus: 'message' };
    case 'R':
      if (state.box) return { ...state, focus: 'reply-field' };
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
