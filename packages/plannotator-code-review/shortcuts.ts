import {
  createDoubleTapShortcutsHook,
  createShortcutRegistry,
  createShortcutScopeHook,
  defineShortcutScope,
  reviewAiShortcuts,
  reviewAllFilesDiffShortcuts,
  reviewAnnotationToolbarShortcuts,
  reviewFileTreeShortcuts,
  reviewPrCommentsShortcuts,
  reviewSuggestionModalShortcuts,
  reviewTourDialogShortcuts,
  type ShortcutSurface,
} from '@plannotator/ui/shortcuts';

export const reviewEditorShortcuts = defineShortcutScope({
  id: 'review-editor',
  title: 'Review Editor',
  shortcuts: {
    submit: {
      description: 'Approve / Send feedback',
      bindings: ['Mod+Enter'],
      section: 'Actions',
      displayOrder: 10,
    },
    focusSearch: {
      description: 'Focus search',
      bindings: ['Mod+F'],
      section: 'Search',
      hint: 'Available when the file tree search bar is shown.',
      displayOrder: 10,
    },
    nextSearchMatch: {
      description: 'Next search result',
      bindings: ['Enter', 'F3'],
      section: 'Search',
      displayOrder: 20,
    },
    prevSearchMatch: {
      description: 'Previous search result',
      bindings: ['Shift+Enter', 'Shift+F3'],
      section: 'Search',
      displayOrder: 30,
    },
    clearSearch: {
      description: 'Clear search / close panel',
      bindings: ['Escape'],
      section: 'Search',
      displayOrder: 40,
    },
    toggleDestination: {
      description: 'Toggle review destination',
      bindings: ['Alt Alt'],
      section: 'Actions',
      hint: 'Double-tap to switch between platform and agent in PR review mode.',
      displayOrder: 30,
    },
    toggleFileTree: {
      description: 'Toggle file tree',
      bindings: ['Mod+B'],
      section: 'Layout',
      displayOrder: 10,
    },
    toggleSidebar: {
      description: 'Toggle review sidebar',
      bindings: ['Mod+.'],
      section: 'Layout',
      displayOrder: 20,
    },
    toggleTour: {
      description: 'Toggle demo tour dialog',
      bindings: ['Mod+Shift+T'],
      section: 'Layout',
      hint: 'Available in dev builds only.',
      displayOrder: 30,
    },
    toggleViewed: {
      description: 'Toggle file viewed',
      bindings: ['V'],
      section: 'File Actions',
      hint: 'Marks the active diff file as viewed (and auto-collapses in all-files view).',
      displayOrder: 10,
    },
    stageFile: {
      description: 'Stage current file',
      bindings: ['A'],
      section: 'File Actions',
      hint: 'Available when staging is supported (not in PR review mode).',
      displayOrder: 20,
    },
  },
});

export const useReviewEditorShortcuts = createShortcutScopeHook(reviewEditorShortcuts);
export const useReviewEditorDoubleTap = createDoubleTapShortcutsHook(reviewEditorShortcuts);

export const reviewSettingsShortcutRegistry = createShortcutRegistry([
  reviewEditorShortcuts,
  reviewFileTreeShortcuts,
  reviewAllFilesDiffShortcuts,
  reviewAnnotationToolbarShortcuts,
  reviewSuggestionModalShortcuts,
  reviewAiShortcuts,
  reviewPrCommentsShortcuts,
  reviewTourDialogShortcuts,
] as const);

export const codeReviewSurface: ShortcutSurface = {
  slug: 'code-review',
  title: 'Code review',
  description: 'Shortcuts surfaced by the code review UI.',
  registry: reviewSettingsShortcutRegistry,
};
