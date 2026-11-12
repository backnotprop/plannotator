import { defineShortcutScope } from '../core';

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
