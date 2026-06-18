import { describe, expect, test } from 'bun:test';
import {
  buildDirectEditsSection,
  buildPlanEditPanelItem,
  buildSavedFileChangePanelItems,
  buildSavedFileChangesSection,
  composeFeedbackWithEditSections,
  composeFeedbackWithDirectEdits,
  computeEditStats,
  normalizeEditedMarkdown,
} from './directEdits';

describe('direct edit feedback helpers', () => {
  test('normalizes unchanged edits to no direct edit', () => {
    const base = '# Plan\n\nKeep this.\n';

    expect(normalizeEditedMarkdown(base, base)).toBeNull();
    expect(normalizeEditedMarkdown(base, null)).toBeNull();
    expect(normalizeEditedMarkdown(base, undefined)).toBeNull();
    expect(normalizeEditedMarkdown(base, '# Plan\n\nChange this.\n')).toBe('# Plan\n\nChange this.\n');
  });

  test('builds the patch from edited markdown, not unrelated shared document state', () => {
    const base = '# Plan\n\nUse the submitted text.\n';
    const edited = '# Plan\n\nUse the direct edit buffer.\n';
    const unrelatedSharedMarkdown = '# Archive\n\nThis text came from another document.\n';

    const section = buildDirectEditsSection(base, edited, false);

    expect(section).toContain('-Use the submitted text.');
    expect(section).toContain('+Use the direct edit buffer.');
    expect(section).not.toContain(unrelatedSharedMarkdown);
    expect(section).not.toContain('This text came from another document.');
  });

  test('replaces empty feedback with direct edits instead of appending the sentinel', () => {
    const edits = buildDirectEditsSection('before\n', 'after\n', false);

    expect(composeFeedbackWithDirectEdits('User reviewed the document and has no feedback.', edits)).toBe(edits);
    expect(composeFeedbackWithDirectEdits('A real annotation.', edits)).toBe(`${edits}\n\n---\n\nA real annotation.`);
  });

  test('includes saved file changes even when they are the only feedback', () => {
    const saved = buildSavedFileChangesSection([
      {
        path: '/repo/docs/a.md',
        basename: 'a.md',
        beforeText: 'before\n',
        afterText: 'after\n',
      },
    ]);

    expect(saved).toContain('already applied');
    expect(composeFeedbackWithEditSections('User reviewed the document and has no feedback.', '', saved))
      .toBe(saved);
    expect(composeFeedbackWithEditSections('Please adjust the intro.', '', saved))
      .toBe(`${saved}\n\n---\n\nPlease adjust the intro.`);
  });

  test('computes line counts for edit badges', () => {
    expect(computeEditStats('one\ntwo\n', 'one\nthree\nfour\n')).toEqual({
      added: 2,
      removed: 1,
    });
  });

  test('builds saved file panel items', () => {
    const [item] = buildSavedFileChangePanelItems([
      {
        key: 'file:/repo/docs/a.md',
        path: '/repo/docs/a.md',
        basename: 'a.md',
        beforeText: 'before\n',
        afterText: 'after\n',
      },
    ]);

    expect(item.id).toBe('saved:file:/repo/docs/a.md');
    expect(item.title).toBe('Edits');
    expect(item.diffText).toContain('-before');
    expect(item.diffText).toContain('+after');
  });

  test('builds plan edit panel items', () => {
    const item = buildPlanEditPanelItem('before\n', 'after\n');

    expect(item.id).toBe('plan');
    expect(item.added).toBe(1);
    expect(item.removed).toBe(1);
    expect(item.diffText).toContain('plan.md (edited)');
  });
});
