import { defineShortcutScope } from '../core';

// Heads-up for future migrators: these bindings (`Alt hold`, `Alt Alt`) are
// declarative metadata for the help modal and marketing docs. They do NOT
// dispatch through `useShortcutScope`. `Alt Alt` works via
// `useDoubleTapShortcuts`; `Alt hold` has no shared hook yet — it's wired
// today by the bespoke `useInputMethodSwitch` hook in
// `packages/editor/hooks/`. See the comment block above
// `useDoubleTapShortcuts` in `packages/ui/shortcuts/runtime.ts`.

export const inputMethodShortcuts = defineShortcutScope({
  id: 'input-method',
  title: 'Input Method',
  shortcuts: {
    temporarySwitch: {
      description: 'Temporarily switch input method',
      bindings: ['Alt hold'],
      section: 'Input Method',
      hint: 'Hold Alt to switch between Select and Pinpoint, then release to revert.',
      displayOrder: 10,
    },
    toggleSwitch: {
      description: 'Toggle input method',
      bindings: ['Alt Alt'],
      section: 'Input Method',
      hint: 'Double-tap Alt to switch between Select and Pinpoint until you toggle again.',
      displayOrder: 20,
    },
  },
});
