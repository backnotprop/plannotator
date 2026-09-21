import { defineShortcutScope } from '../core';
import {
  useShortcutScope,
  type ShortcutHandlers,
  type UseShortcutScopeOptions,
} from '../runtime';

// Shift+digit rather than mnemonic letters: bare letters are swallowed by
// type-to-comment, bare digits by the label picker, Mod+digit by the browser's
// tab switching, and Mod+Shift+3/4 by macOS screenshots. Follows the toolstrip
// left to right.
export const annotationModeShortcuts = defineShortcutScope({
  id: 'annotation-mode',
  title: 'Annotation Mode',
  shortcuts: {
    selectMarkupMode: {
      description: 'Markup mode',
      bindings: ['Shift+1'],
      section: 'Annotations',
      hint: 'Selecting text opens the annotation toolbar.',
      preventDefault: true,
      displayOrder: 1,
    },
    selectCommentMode: {
      description: 'Comment mode',
      bindings: ['Shift+2'],
      section: 'Annotations',
      hint: 'Selecting text opens the comment editor.',
      preventDefault: true,
      displayOrder: 2,
    },
    selectRedlineMode: {
      description: 'Redline mode',
      bindings: ['Shift+3'],
      section: 'Annotations',
      hint: 'Selecting text marks it for deletion.',
      preventDefault: true,
      displayOrder: 3,
    },
    selectQuickLabelMode: {
      description: 'Label mode',
      bindings: ['Shift+4'],
      section: 'Annotations',
      hint: 'Selecting text opens the quick label picker.',
      preventDefault: true,
      displayOrder: 4,
    },
  },
});

// --- Type-to-comment capture guard (#1244 follow-up) ---
// Shift+1..4 produce printable characters (! @ # $). While a surface's
// type-to-comment listener owns printable keys (a selection exists and the
// annotation toolbar is open), those characters belong to the comment being
// started: a mode shortcut firing there both eats the character and silently
// re-arms the mode (Shift+3 arming Redline mid-thought). The toolbar
// registers its capture here; the scope hook refuses to dispatch while any
// capture is held.
let typeToCommentCaptures = 0;

/**
 * Held by AnnotationToolbar for the lifetime of its type-to-comment keydown
 * listener. Returns a release function; releasing more than once is safe.
 */
export function acquireTypeToCommentCapture(): () => void {
  typeToCommentCaptures += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    typeToCommentCaptures -= 1;
  };
}

type AnnotationModeScope = typeof annotationModeShortcuts;
type AnnotationModeOptions = Omit<UseShortcutScopeOptions<AnnotationModeScope>, 'scope'>;

export function useAnnotationModeShortcuts(options: AnnotationModeOptions): void {
  const guarded: ShortcutHandlers<AnnotationModeScope> = {};
  for (const actionId of Object.keys(options.handlers) as Array<keyof typeof options.handlers>) {
    const handler = options.handlers[actionId];
    if (!handler) continue;
    const config = typeof handler === 'function' ? { handle: handler } : handler;
    guarded[actionId] = {
      ...config,
      when: (event: KeyboardEvent) =>
        typeToCommentCaptures === 0 && (config.when ? config.when(event) : true),
    };
  }
  useShortcutScope({ scope: annotationModeShortcuts, ...options, handlers: guarded });
}
