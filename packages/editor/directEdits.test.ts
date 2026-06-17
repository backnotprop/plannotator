import { describe, expect, test } from 'bun:test';
import {
  buildDirectEditsSection,
  buildSavedFileChangesSection,
  composeFeedbackWithEditSections,
  composeFeedbackWithDirectEdits,
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
});
