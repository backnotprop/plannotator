import {
  annotationPanelShortcuts,
  annotationToolbarShortcuts,
  commentPopoverShortcuts,
  createShortcutRegistry,
  createShortcutScopeHook,
  defineShortcutScope,
  imageAnnotatorShortcuts,
  inputMethodShortcuts,
  viewerShortcuts,
  type ShortcutSurface,
} from '@plannotator/ui/shortcuts';

export const planEditorShortcuts = defineShortcutScope({
  id: 'plan-editor',
  title: 'Plan Editor',
  shortcuts: {
    submitPlan: {
      description: 'Approve / Send feedback',
      bindings: ['Mod+Enter'],
      section: 'Actions',
      hint: 'Approves when there are no annotations and sends feedback when there are.',
      displayOrder: 10,
    },
    submitAnnotations: {
      description: 'Send annotations',
      bindings: ['Mod+Enter'],
      section: 'Actions',
      displayOrder: 10,
    },
    quickSave: {
      description: 'Save to notes app',
      bindings: ['Mod+S'],
      section: 'Actions',
      hint: 'Opens Export if no default notes app is configured.',
      displayOrder: 20,
    },
    exitPlanDiff: {
      description: 'Close diff view',
      bindings: ['Escape'],
      section: 'Actions',
      hint: 'Available while plan diff is open.',
      displayOrder: 30,
    },
    printPlan: {
      description: 'Print',
      bindings: ['Mod+P'],
      section: 'Actions',
      hint: 'Opens the browser print dialog for the current document.',
      displayOrder: 40,
    },
  },
});

export const usePlanEditorShortcuts = createShortcutScopeHook(planEditorShortcuts);

const planReviewEditorSettingsShortcuts = defineShortcutScope({
  id: 'plan-review-editor-settings',
  title: 'Plan Editor',
  shortcuts: {
    submitPlan: planEditorShortcuts.shortcuts.submitPlan,
    quickSave: planEditorShortcuts.shortcuts.quickSave,
    exitPlanDiff: planEditorShortcuts.shortcuts.exitPlanDiff,
    printPlan: planEditorShortcuts.shortcuts.printPlan,
  },
});

const annotateEditorSettingsShortcuts = defineShortcutScope({
  id: 'annotate-editor-settings',
  title: 'Annotate Editor',
  shortcuts: {
    submitAnnotations: planEditorShortcuts.shortcuts.submitAnnotations,
    quickSave: planEditorShortcuts.shortcuts.quickSave,
    printPlan: planEditorShortcuts.shortcuts.printPlan,
  },
});

const sharedPlanSurfaceShortcuts = [
  inputMethodShortcuts,
  annotationToolbarShortcuts,
  viewerShortcuts,
  commentPopoverShortcuts,
  annotationPanelShortcuts,
  imageAnnotatorShortcuts,
] as const;

export const planReviewSettingsShortcutRegistry = createShortcutRegistry([
  planReviewEditorSettingsShortcuts,
  ...sharedPlanSurfaceShortcuts,
] as const);

export const annotateSettingsShortcutRegistry = createShortcutRegistry([
  annotateEditorSettingsShortcuts,
  ...sharedPlanSurfaceShortcuts,
] as const);

export const planReviewSurface: ShortcutSurface = {
  slug: 'plan-review',
  title: 'Plan review',
  description: 'Shortcuts surfaced by the plan review UI.',
  registry: planReviewSettingsShortcutRegistry,
};

export const annotateSurface: ShortcutSurface = {
  slug: 'annotate-mode',
  title: 'Annotate mode',
  description: 'Shortcuts surfaced by the standalone annotation UI.',
  registry: annotateSettingsShortcutRegistry,
};
