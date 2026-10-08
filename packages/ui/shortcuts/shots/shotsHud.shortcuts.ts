import { defineShortcutScope } from '../core';
import { createShortcutScopeHook } from '../runtime';

/**
 * Plannotator Shots: keys inside the HUD panel (DESIGN §4). The global
 * capture hotkeys (⌥⇧⌘4 / ⌥⇧⌘5 / ⌥⇧⌘P) belong to the native app.
 */
export const shotsHudShortcuts = defineShortcutScope({
  id: 'shots-hud',
  title: 'Plannotator Shots',
  shortcuts: {
    boxTool: { description: 'Box tool', bindings: ['R'], section: 'Tools', displayOrder: 10 },
    arrowTool: { description: 'Arrow', bindings: ['A'], section: 'Tools', displayOrder: 20 },
    drawTool: { description: 'Draw', bindings: ['D'], section: 'Tools', displayOrder: 30 },
    redactTool: { description: 'Redact: black out an area in everything the agent receives', bindings: ['B'], section: 'Tools', displayOrder: 40 },
    noteTool: { description: 'Note on this image', bindings: ['N'], section: 'Tools', displayOrder: 50 },
    viewText: { description: 'View text (Snapshots)', bindings: ['T'], section: 'Shots', displayOrder: 60 },
    previousShot: { description: 'Previous shot', bindings: ['ArrowLeft'], section: 'Shots', displayOrder: 70 },
    nextShot: { description: 'Next shot', bindings: ['ArrowRight'], section: 'Shots', displayOrder: 80 },
    deleteSelection: { description: 'Delete the selected box (or the shot)', bindings: ['Backspace', 'Delete'], section: 'Shots', displayOrder: 90 },
    undo: { description: 'Undo', bindings: ['Mod+Z'], section: 'Shots', preventDefault: true, displayOrder: 100 },
    redo: { description: 'Redo', bindings: ['Mod+Shift+Z'], section: 'Shots', preventDefault: true, displayOrder: 110 },
    chooseDestination: { description: 'Choose destination', bindings: ['Mod+K'], section: 'Send', preventDefault: true, displayOrder: 120 },
    ask: { description: 'Ask this session', bindings: ['Mod+J'], section: 'Send', preventDefault: true, displayOrder: 130 },
    send: { description: 'Send all', bindings: ['Mod+Enter'], section: 'Send', preventDefault: true, displayOrder: 140 },
    copyMarkdown: { description: 'Copy as Markdown', bindings: ['Mod+Shift+C'], section: 'Send', preventDefault: true, displayOrder: 150 },
    back: { description: 'Step back: composer, Ask, then collapse to the strip', bindings: ['Escape'], section: 'Shots', displayOrder: 160 },
  },
});

export const useShotsHudShortcuts = createShortcutScopeHook(shotsHudShortcuts);
