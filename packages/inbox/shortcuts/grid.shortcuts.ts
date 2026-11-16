import { defineShortcutScope } from '@plannotator/ui/shortcuts';

/**
 * Arrow keys between tiles (approval "inbox-keyboard-keys-2026-11-07", items 1 and 6): no new letters, the list's
 * pattern. Each acts only while a tile or card has focus (its component's `when`), so the page's scrolling elsewhere
 * is untouched; Enter opens and Shift+F10 opens a card's menu, as before. The moves are `gridMove.ts`.
 */
export const inboxArtifactsShortcuts = defineShortcutScope({
  id: 'inbox-artifacts',
  title: 'Artifacts',
  shortcuts: {
    // ArtifactsView.tsx: ← → the tile before or after, ↑ ↓ the tile above or below, Home End the first or last.
    move: { description: 'Move between the Artifacts tiles', bindings: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'], section: 'Files', preventDefault: true, displayOrder: 5.2 },
    ends: { description: 'First or last tile', bindings: ['Home', 'End'], section: 'Files', preventDefault: true, displayOrder: 5.3 },
  },
});

export const inboxBoardShortcuts = defineShortcutScope({
  id: 'inbox-board',
  title: 'Board',
  shortcuts: {
    // BoardPage.tsx: ← → the nearest card in the lane beside, ↑ ↓ within a lane, Home End the lane's first or last.
    move: { description: 'Move between Board cards', bindings: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'], section: 'List', preventDefault: true, displayOrder: 8 },
    ends: { description: 'First or last card in the lane', bindings: ['Home', 'End'], section: 'List', preventDefault: true, displayOrder: 9 },
  },
});

/**
 * Arrow keys between a message's attachment tiles (Thread.tsx; the owner, 2026-11-12): only while a tile has focus,
 * within that message's own tiles (the foot's, or the header band's copy), never into another message, nothing past
 * an end. A message with one tile leaves the arrows to the page. Home and End keep scrolling the thread.
 */
export const inboxTileShortcuts = defineShortcutScope({
  id: 'inbox-tiles',
  title: 'Attachments',
  shortcuts: {
    move: { description: 'Move between a message’s attachments', bindings: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'], section: 'Files', preventDefault: true, displayOrder: 5.4 },
  },
});
