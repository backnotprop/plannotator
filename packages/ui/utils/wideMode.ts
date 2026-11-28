import type { SidebarTab } from '@plannotator/ui/hooks/useSidebar';
import type { WideModeType } from '@plannotator/ui/types';
import { parseAnnotateView } from '@plannotator/core/config-types';
export type { WideModeType } from '@plannotator/ui/types';

export type WideModeLayoutSnapshot = {
  sidebarIsOpen: boolean;
  sidebarTab: SidebarTab;
  panelOpen: boolean;
};

export type WideModeExitOptions = {
  restore?: boolean;
  sidebarTab?: SidebarTab;
  panelOpen?: boolean;
};

export type WideModeExitLayout = {
  sidebarOpen: boolean;
  sidebarTab: SidebarTab | null;
  panelOpen?: boolean;
};

export function canUseAnnotateWideMode(options: {
  archiveMode: boolean;
  isPlanDiffActive: boolean;
}): boolean {
  return !options.archiveMode && !options.isPlanDiffActive;
}

/** What the focus-mode keyboard shortcut should do on this press. */
export type FocusShortcutAction = 'enter-focus' | 'exit' | 'none';

/**
 * Decide the next step for the focus-mode keyboard shortcut.
 *
 * The shortcut is a single "hide the chrome / give it back" toggle, so ANY
 * active panel-hiding view mode restores the remembered layout — including
 * `wide`, which the toolbar control would instead swap for `focus`. A press
 * that could only re-hide already-hidden panels would look like a dead key.
 */
export function resolveFocusShortcutAction(state: {
  canUseWideMode: boolean;
  wideModeType: WideModeType | null;
}): FocusShortcutAction {
  if (state.wideModeType !== null) return 'exit';
  return state.canUseWideMode ? 'enter-focus' : 'none';
}

export function resolveWideModeExitLayout(
  snapshot: WideModeLayoutSnapshot | null,
  options?: WideModeExitOptions,
): WideModeExitLayout {
  const restore = options?.restore !== false;

  if (options?.sidebarTab) {
    return {
      sidebarOpen: true,
      sidebarTab: options.sidebarTab,
      panelOpen: options.panelOpen,
    };
  }

  return {
    sidebarOpen: restore ? (snapshot?.sidebarIsOpen ?? false) : false,
    sidebarTab: restore && snapshot?.sidebarIsOpen ? snapshot.sidebarTab : null,
    panelOpen: options?.panelOpen ?? (restore ? (snapshot?.panelOpen ?? false) : undefined),
  };
}

/** The views an annotate session can open in (config.json `annotateView`). */
export type AnnotateOpenView = WideModeType | 'edit';

/**
 * Narrow serverConfig's `annotateView` to a view the toolbar offers; anything
 * else (unset, a typo, another type) is null, today's default.
 */
export function parseAnnotateOpenView(value: unknown): AnnotateOpenView | null {
  return parseAnnotateView(value) ?? null;
}

/**
 * The view to open an annotate session in, or null for today's default
 * (panels as they are, not editing). A configured view the toolbar does not
 * offer for this document falls back to null, silently: the toolbar hidden
 * (HTML, a compact touch layout, archive, plan diff, no document yet), Wide
 * or Focus where the view switch is off, Edit where the document cannot be
 * edited.
 */
export function resolveAnnotateOpenView(
  configured: AnnotateOpenView | null | undefined,
  state: { toolbarShown: boolean; canUseWideMode: boolean; canEditMarkdown: boolean },
): AnnotateOpenView | null {
  if (!configured || !state.toolbarShown) return null;
  if (configured === 'edit') return state.canEditMarkdown ? 'edit' : null;
  return state.canUseWideMode ? configured : null;
}
