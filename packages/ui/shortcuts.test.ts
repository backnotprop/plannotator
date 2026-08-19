import { describe, expect, it } from 'bun:test';
import { annotateSettingsShortcutRegistry, planEditorShortcuts, planReviewSettingsShortcutRegistry } from '../editor/shortcuts';
import { reviewSettingsShortcutRegistry } from '../review-editor/shortcuts';
import {
  annotationModeShortcuts,
  createShortcutRegistry,
  defineShortcutScope,
  dispatchShortcutEvent,
  formatShortcutBindingText,
  formatShortcutBindingTokens,
  getShortcut,
  listRegistryShortcuts,
  listRegistryShortcutSections,
  matchesKeyName,
  matchesShortcutBinding,
  parseDoubleTapBinding,
  validateShortcutRegistry,
} from './shortcuts';

describe('shortcuts', () => {
  it('formats bindings for docs and keycaps', () => {
    expect(formatShortcutBindingText('Mod+Enter')).toBe('Cmd/Ctrl+Enter');
    expect(formatShortcutBindingText('Alt hold')).toBe('Hold Alt');
    expect(formatShortcutBindingText('Alt Alt')).toBe('Double-tap Alt');
    expect(formatShortcutBindingText('Alt Alt', 'mac')).toBe('Double-tap Option');
    expect(formatShortcutBindingTokens('Mod+Enter', 'mac')).toEqual(['⌘', '⏎']);
    expect(formatShortcutBindingTokens('Mod+Enter', 'non-mac')).toEqual(['Ctrl', '↵']);
    expect(formatShortcutBindingTokens('Alt Alt', 'mac')).toEqual(['⌥', '×2']);
    expect(formatShortcutBindingTokens('Alt Alt', 'non-mac')).toEqual(['Alt', '×2']);
  });

  it('validates duplicate scope ids and non-normalized tokens', () => {
    const duplicateScope = defineShortcutScope({
      id: 'dup',
      title: 'Duplicate',
      shortcuts: {
        submit: {
          description: 'Submit',
          bindings: ['Mod+Enter'],
          section: 'Actions',
        },
      },
    });

    const badScope = defineShortcutScope({
      id: 'bad',
      title: 'Bad',
      shortcuts: {
        broken: {
          description: 'Broken',
          bindings: ['Cmd+Enter'],
          section: 'Actions',
        },
        missingCopy: {
          description: '',
          bindings: ['Mod+C'],
          section: '',
        },
      },
    });

    const errors = validateShortcutRegistry([duplicateScope, duplicateScope, badScope]);

    expect(errors).toContain('Duplicate shortcut scope id: dup');
    expect(errors.some(error => error.includes('Cmd'))).toBe(true);
    expect(errors).toContain('Shortcut bad.missingCopy is missing a section.');
    expect(errors).toContain('Shortcut bad.missingCopy is missing a description.');
    expect(() => createShortcutRegistry([duplicateScope, duplicateScope])).toThrow();
  });

  it('lists plan review, annotate, and review sections from assembled registries', () => {
    const planReviewSections = listRegistryShortcutSections(planReviewSettingsShortcutRegistry);
    const annotateSections = listRegistryShortcutSections(annotateSettingsShortcutRegistry);
    const reviewSections = listRegistryShortcutSections(reviewSettingsShortcutRegistry);

    expect(planReviewSections.map(section => section.title)).toEqual([
      'Actions',
      'View',
      'Input Method',
      'Annotations',
      'Vim Document Navigation',
      'Vim Text Navigation',
      'Vim Annotation Actions',
      'Image Annotator',
    ]);

    expect(annotateSections.map(section => section.title)).toEqual([
      'Actions',
      'Sidebar',
      'View',
      'Input Method',
      'Annotations',
      'Vim Document Navigation',
      'Vim Text Navigation',
      'Vim Annotation Actions',
      'Image Annotator',
    ]);

    expect(getShortcut(planReviewSettingsShortcutRegistry, 'plan-review-editor-settings', 'submitPlan')?.description).toBe('Approve / Send feedback');
    expect(getShortcut(planReviewSettingsShortcutRegistry, 'plan-review-editor-settings', 'submitAnnotations')).toBeUndefined();
    expect(getShortcut(annotateSettingsShortcutRegistry, 'annotate-editor-settings', 'submitAnnotations')?.description).toBe('Send annotations');
    expect(getShortcut(annotateSettingsShortcutRegistry, 'annotate-editor-settings', 'submitPlan')).toBeUndefined();
    expect(getShortcut(annotateSettingsShortcutRegistry, 'annotate-sidebar', 'toggleContents')?.description).toBe('Toggle Contents sidebar');

    expect(reviewSections.map(section => section.title)).toEqual([
      'Actions',
      'Search',
      'Layout',
      'File Actions',
      'File Navigation',
      'All-Files View',
      'Annotations',
      'Suggestion Editor',
      'AI Assistant',
      'PR Comments',
      'Tour',
    ]);
  });

  // The focus-mode toggle collapses both side panels at once. It has to exist
  // on BOTH plan surfaces (they render the same panels), and its binding has to
  // stay the only claim on `Mod+.` there — a second claimant would double-fire,
  // since the dispatcher has no cross-scope arbitration.
  it('binds focus mode once on every plan surface', () => {
    for (const registry of [planReviewSettingsShortcutRegistry, annotateSettingsShortcutRegistry]) {
      expect(getShortcut(registry, 'document-view', 'toggleFocusMode')?.bindings).toEqual(['Mod+.']);

      const claimants = listRegistryShortcuts(registry)
        .filter(entry => entry.bindings.includes('Mod+.'))
        .map(entry => `${entry.scopeId}.${entry.actionId}`);
      expect(claimants).toEqual(['document-view.toggleFocusMode']);
    }
  });

  // The mode switcher renders on both plan surfaces, so the scope has to reach
  // both registries — and each digit has to stay a single claimant, since the
  // dispatcher has no cross-scope arbitration.
  it('binds annotation mode once on every plan surface', () => {
    const expected = {
      selectMarkupMode: ['Shift+1'],
      selectCommentMode: ['Shift+2'],
      selectRedlineMode: ['Shift+3'],
      selectQuickLabelMode: ['Shift+4'],
    };

    for (const registry of [planReviewSettingsShortcutRegistry, annotateSettingsShortcutRegistry]) {
      for (const [actionId, bindings] of Object.entries(expected)) {
        expect(getShortcut(registry, 'annotation-mode', actionId)?.bindings).toEqual(bindings);

        const claimants = listRegistryShortcuts(registry)
          .filter(entry => entry.bindings.includes(bindings[0]))
          .map(entry => `${entry.scopeId}.${entry.actionId}`);
        expect(claimants).toEqual([`annotation-mode.${actionId}`]);
      }
    }
  });

  // The quick-label picker claims bare digits. Holding Shift has to steer the
  // keystroke to the mode switcher instead of firing both.
  it('does not fire the bare-digit label picker while Shift is held', () => {
    const shiftedDigit = {
      key: '!', code: 'Digit1', ctrlKey: false, metaKey: false, shiftKey: true, altKey: false,
    } as KeyboardEvent;

    expect(matchesShortcutBinding(shiftedDigit, '1-0')).toBe(false);
    expect(matchesShortcutBinding(shiftedDigit, 'Shift+1')).toBe(true);
  });

  it('matches normalized runtime bindings', () => {
    const submitEvent = { key: 'Enter', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, code: 'Enter' } as KeyboardEvent;
    const reverseSearchEvent = { key: 'F3', ctrlKey: false, metaKey: false, shiftKey: true, altKey: false, code: 'F3' } as KeyboardEvent;
    const typeEvent = { key: 'A', ctrlKey: false, metaKey: false, shiftKey: true, altKey: false, code: 'KeyA' } as KeyboardEvent;
    const quickLabelEvent = { key: '3', ctrlKey: false, metaKey: false, shiftKey: false, altKey: true, code: 'Digit3' } as KeyboardEvent;
    const macOptionQuickLabelEvent = { key: '£', ctrlKey: false, metaKey: false, shiftKey: false, altKey: true, code: 'Digit3' } as KeyboardEvent;
    const wrongEvent = { key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false, altKey: true, code: 'Enter' } as KeyboardEvent;
    const spaceEvent = {
      key: ' ',
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      code: 'Space',
    };
    const questionEvent = {
      key: '?',
      ctrlKey: false,
      metaKey: false,
      shiftKey: true,
      altKey: false,
      code: 'Slash',
    };

    expect(matchesShortcutBinding(submitEvent, 'Mod+Enter')).toBe(true);
    expect(matchesShortcutBinding(reverseSearchEvent, 'Shift+F3')).toBe(true);
    expect(matchesShortcutBinding(typeEvent, 'A-Z')).toBe(true);
    expect(matchesShortcutBinding(quickLabelEvent, 'Alt+1-0')).toBe(true);
    expect(matchesShortcutBinding(macOptionQuickLabelEvent, 'Alt+1-0')).toBe(true);
    expect(matchesShortcutBinding(spaceEvent, 'Space')).toBe(true);
    expect(matchesShortcutBinding(questionEvent, '?')).toBe(true);
    expect(matchesShortcutBinding(wrongEvent, 'Mod+Enter')).toBe(false);
  });

  it('dispatches matching registry actions', () => {
    const calls: string[] = [];
    const event = { key: 'Enter', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false } as KeyboardEvent;

    const handled = dispatchShortcutEvent(planReviewSettingsShortcutRegistry[0], {
      submitPlan: () => calls.push('submitPlan'),
      quickSave: () => calls.push('quickSave'),
    }, event);

    expect(handled).toBe(true);
    expect(calls).toEqual(['submitPlan']);
  });

  it('can dispatch annotate submit after plan submit declines the same binding', () => {
    const calls: string[] = [];
    const event = {
      key: 'Enter',
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => calls.push('preventDefault'),
    } as unknown as KeyboardEvent;

    const handled = dispatchShortcutEvent(planEditorShortcuts, {
      submitPlan: {
        when: () => false,
        handle: () => calls.push('submitPlan'),
      },
      submitAnnotations: {
        when: () => true,
        handle: () => {
          event.preventDefault();
          calls.push('submitAnnotations');
        },
      },
    }, event);

    expect(handled).toBe(true);
    expect(calls).toEqual(['preventDefault', 'submitAnnotations']);
  });

  it('supports guarded handlers and continues after a failed guard', () => {
    const guardedScope = defineShortcutScope({
      id: 'guarded',
      title: 'Guarded',
      shortcuts: {
        primary: {
          description: 'Primary',
          bindings: ['Enter'],
          section: 'Actions',
          preventDefault: true,
        },
        fallback: {
          description: 'Fallback',
          bindings: ['Enter'],
          section: 'Actions',
          preventDefault: true,
        },
      },
    });

    const calls: string[] = [];
    const event = {
      key: 'Enter',
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => calls.push('preventDefault'),
    } as unknown as KeyboardEvent;

    const handled = dispatchShortcutEvent(guardedScope, {
      primary: {
        when: () => false,
        handle: () => calls.push('primary'),
      },
      fallback: {
        when: () => true,
        handle: () => calls.push('fallback'),
      },
    }, event);

    expect(handled).toBe(true);
    expect(calls).toEqual(['preventDefault', 'fallback']);
  });

  it('parses double-tap bindings', () => {
    expect(parseDoubleTapBinding('Alt Alt')).toBe('Alt');
    expect(parseDoubleTapBinding('Shift Shift')).toBe('Shift');
    expect(parseDoubleTapBinding('Alt hold')).toBeNull();
    expect(parseDoubleTapBinding('Mod+Enter')).toBeNull();
    expect(parseDoubleTapBinding('Alt Shift')).toBeNull(); // different keys
    expect(parseDoubleTapBinding('Alt+Shift Alt+Shift')).toBeNull(); // multi-key groups
  });

  it('matches key names for sequential binding support', () => {
    const altEvent = { key: 'Alt' } as KeyboardEvent;
    const shiftEvent = { key: 'Shift' } as KeyboardEvent;
    const metaEvent = { key: 'Meta' } as KeyboardEvent;
    const ctrlEvent = { key: 'Control' } as KeyboardEvent;

    expect(matchesKeyName(altEvent, 'Alt')).toBe(true);
    expect(matchesKeyName(altEvent, 'Shift')).toBe(false);
    expect(matchesKeyName(shiftEvent, 'Shift')).toBe(true);
    expect(matchesKeyName(metaEvent, 'Mod')).toBe(true);
    expect(matchesKeyName(ctrlEvent, 'Mod')).toBe(true);
  });

  it('does not handle or prevent default when a guard fails', () => {
    const guardedScope = defineShortcutScope({
      id: 'guarded-skip',
      title: 'Guarded Skip',
      shortcuts: {
        save: {
          description: 'Save',
          bindings: ['Mod+S'],
          section: 'Actions',
          preventDefault: true,
        },
      },
    });

    let preventDefaultCalls = 0;
    const event = {
      key: 's',
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => {
        preventDefaultCalls += 1;
      },
    } as unknown as KeyboardEvent;

    const handled = dispatchShortcutEvent(guardedScope, {
      save: {
        when: () => false,
        handle: () => {
          throw new Error('should not run');
        },
      },
    }, event);

    expect(handled).toBe(false);
    expect(preventDefaultCalls).toBe(0);
  });

  it('switches annotation mode on Shift+1-4 across keyboard layouts', () => {
    const calls: string[] = [];
    const handlers = {
      selectMarkupMode: () => calls.push('selection'),
      selectCommentMode: () => calls.push('comment'),
      selectRedlineMode: () => calls.push('redline'),
      selectQuickLabelMode: () => calls.push('quickLabel'),
    };

    let preventDefaultCalls = 0;
    const preventDefault = () => {
      preventDefaultCalls += 1;
    };

    // Shift+2 reports '@' on a US layout, so matching has to fall back to event.code.
    const shiftedDigit = {
      key: '@', code: 'Digit2', ctrlKey: false, metaKey: false, shiftKey: true, altKey: false, preventDefault,
    } as unknown as KeyboardEvent;
    expect(dispatchShortcutEvent(annotationModeShortcuts, handlers, shiftedDigit)).toBe(true);

    const plainDigit = {
      key: '3', code: 'Digit3', ctrlKey: false, metaKey: false, shiftKey: true, altKey: false, preventDefault,
    } as unknown as KeyboardEvent;
    expect(dispatchShortcutEvent(annotationModeShortcuts, handlers, plainDigit)).toBe(true);

    expect(calls).toEqual(['comment', 'redline']);
    expect(preventDefaultCalls).toBe(2);
  });

  it('leaves annotation mode alone when Alt is held', () => {
    // AltGr sends Ctrl+Alt; the binding declares no Alt, so it must not fire.
    const altGrEvent = {
      key: '1', code: 'Digit1', ctrlKey: false, metaKey: false, shiftKey: true, altKey: true,
      preventDefault: () => {
        throw new Error('should not run');
      },
    } as unknown as KeyboardEvent;

    const handled = dispatchShortcutEvent(annotationModeShortcuts, {
      selectMarkupMode: () => {
        throw new Error('should not run');
      },
    }, altGrEvent);

    expect(handled).toBe(false);
  });
});
