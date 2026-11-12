import { defineShortcutScope } from '@plannotator/ui/shortcuts';

export const inboxArtifactsShortcuts = defineShortcutScope({
  id: 'inbox-artifacts',
  title: 'Artifacts',
  shortcuts: {
    move: { description: 'Move between the Artifacts tiles', bindings: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'], section: 'Files', preventDefault: true, displayOrder: 5.2 },
    ends: { description: 'First or last tile', bindings: ['Home', 'End'], section: 'Files', preventDefault: true, displayOrder: 5.3 },
  },
});

export const inboxBoardShortcuts = defineShortcutScope({
  id: 'inbox-board',
  title: 'Board',
  shortcuts: {
    move: { description: 'Move between Board cards', bindings: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'], section: 'List', preventDefault: true, displayOrder: 8 },
    ends: { description: 'First or last card in the lane', bindings: ['Home', 'End'], section: 'List', preventDefault: true, displayOrder: 9 },
  },
});
