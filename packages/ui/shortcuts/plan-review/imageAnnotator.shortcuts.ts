import { defineShortcutScope } from '../core';
import { createShortcutScopeHook } from '../runtime';

export const imageAnnotatorShortcuts = defineShortcutScope({
  id: 'image-annotator',
  title: 'Image Annotator',
  shortcuts: {
    penTool: {
      description: 'Pen tool',
      bindings: ['1'],
      section: 'Image Annotator',
      displayOrder: 10,
    },
    arrowTool: {
      description: 'Arrow tool',
      bindings: ['2'],
      section: 'Image Annotator',
      displayOrder: 20,
    },
    circleTool: {
      description: 'Circle tool',
      bindings: ['3'],
      section: 'Image Annotator',
      displayOrder: 30,
    },
    undo: {
      description: 'Undo',
      bindings: ['Mod+Z'],
      section: 'Image Annotator',
      displayOrder: 40,
    },
    save: {
      description: 'Save and close annotator',
      bindings: ['Enter', 'Escape'],
      section: 'Image Annotator',
      hint: 'When the image name field is focused, Escape blurs it first and Enter confirms the name; both close the annotator otherwise.',
      displayOrder: 50,
    },
  },
});

export const useImageAnnotatorShortcuts = createShortcutScopeHook(imageAnnotatorShortcuts);
