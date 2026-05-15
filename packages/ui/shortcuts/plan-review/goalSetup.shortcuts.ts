import { defineShortcutScope } from '../core';
import { createShortcutScopeHook } from '../runtime';

export const goalSetupShortcuts = defineShortcutScope({
  id: 'goal-setup-surface',
  title: 'Goal Setup',
  shortcuts: {},
});

export const useGoalSetupShortcuts = createShortcutScopeHook(goalSetupShortcuts);
