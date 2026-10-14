/**
 * The comments on a guided review's diffs ride a Send as the review app's own
 * export. The Inbox window cannot import the review app's exporter (its strict
 * typecheck does not reach review-editor), so it writes the per-file sections
 * itself; this keeps them equal to `exportReviewFeedback`, so a change to the
 * review app's format that is not made here fails.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxAnnotationRecord } from '@plannotator/core/inbox-types';
import type { CodeAnnotation } from '@plannotator/ui/types';
import { exportReviewFeedback } from '@plannotator/review-editor/utils/exportFeedback';
import { attachmentFeedback, guideCommentSections, guideFeedback, recordQuote, recordTag } from './attachments';

const comments: CodeAnnotation[] = [
  { id: 'a', type: 'comment', scope: 'line', filePath: 'src/auth.ts', lineStart: 12, lineEnd: 12, side: 'new', text: 'Refresh earlier.', selectedText: '  if (expired) refresh();', createdAt: 1 },
  { id: 'b', type: 'comment', scope: 'line', filePath: 'src/auth.ts', lineStart: 3, lineEnd: 5, side: 'old', text: 'Why was this removed?', selectedText: 'a\nb\nc', createdAt: 2 },
  {
    id: 'c',
    type: 'suggestion',
    scope: 'line',
    filePath: 'package.json',
    lineStart: 2,
    lineEnd: 2,
    side: 'new',
    text: 'Pin it.',
    suggestedCode: '"version": "1.0.1"',
    originalCode: '"version": "^1.0.1"',
    selectedText: '"version": "^1.0.1"',
    conventionalLabel: 'suggestion',
    decorations: ['non-blocking'],
    createdAt: 3,
  },
  { id: 'd', type: 'comment', scope: 'line', filePath: 'package.json', lineStart: 1, lineEnd: 1, side: 'new', text: 'This token.', tokenText: 'name', charStart: 3, charEnd: 7, createdAt: 4 },
];

function record(annotation: CodeAnnotation, title = 'Token refresh', messageId = 'msg_1'): InboxAnnotationRecord {
  return {
    id: annotation.id,
    project_id: 'prj_1',
    thread_id: 'msg_1',
    message_id: messageId,
    attachment_id: '',
    path: annotation.filePath,
    version: 'f'.repeat(64),
    guide: { title, file: annotation.filePath, side: annotation.side, line_start: annotation.lineStart, line_end: annotation.lineEnd },
    annotation: annotation as unknown as Record<string, unknown>,
    created_at: '2026-10-11T00:00:00.000Z',
    updated_at: '2026-10-11T00:00:00.000Z',
    removed_at: null,
    sent_reply_id: null,
  };
}

describe('guided-review comments as feedback', () => {
  test("the per-file sections are the review app's export", () => {
    expect(guideCommentSections(comments)).toBe(exportReviewFeedback(comments).replace(/^# Code Review Feedback\n\n/, ''));
  });

  test('quoted code holding a ``` run gets a longer fence, in both exporters alike', () => {
    const tricky: CodeAnnotation[] = [
      { id: 't', type: 'suggestion', scope: 'line', filePath: 'README.md', lineStart: 4, lineEnd: 6, side: 'new', text: 'Fix the fence.', selectedText: 'Example:\n```\nnpm i\n```', originalCode: 'x ```` y', suggestedCode: 'plain', createdAt: 5 },
    ];
    const sections = guideCommentSections(tricky);
    expect(sections).toBe(exportReviewFeedback(tricky).replace(/^# Code Review Feedback\n\n/, ''));
    expect(sections).toContain('**Highlighted text:**\n````\nExample:\n```\nnpm i\n```\n````\n');
    expect(sections).toContain('**Replaces:**\n`````\nx ```` y\n`````\n');
    expect(sections).toContain('**Suggested code:**\n```\nplain\n```\n');
  });

  test('each guided review gets its own section under the heading, after the attached files', () => {
    const text = guideFeedback([record(comments[0]!), record(comments[2]!, 'Second guide', 'msg_2')]);
    expect(text.match(/^# Feedback on the guided review$/gm)).toHaveLength(2);
    expect(text).toContain('"Token refresh"');
    expect(text).toContain('"Second guide"');

    const files: InboxAnnotationRecord = {
      ...record(comments[0]!),
      id: 'file-ann',
      attachment_id: 'att_1',
      path: '/p/notes.md',
      version: 'current',
      annotation: { id: 'file-ann', type: 'COMMENT', text: 'On the notes.', originalText: 'Notes', blockId: 'block-0', startOffset: 0, endOffset: 0, createdA: 1 },
    };
    delete files.guide;
    const both = attachmentFeedback(
      [files, record(comments[0]!)],
      [{ id: 'att_1', path: '/p/notes.md', name: 'notes.md', kind: 'markdown' } as never],
      new Map([['att_1\0current', '# Notes\n']]),
      '/p',
    );
    expect(both.indexOf('# Feedback on the attached files')).toBeLessThan(both.indexOf('# Feedback on the guided review'));
    expect(attachmentFeedback([files], [{ id: 'att_1', path: '/p/notes.md', name: 'notes.md', kind: 'markdown' } as never], new Map(), '/p')).not.toContain('guided review');
  });

  test("the reply's list names a comment's lines and quotes its first line", () => {
    expect(recordTag(record(comments[1]!))).toBe('lines 3-5');
    expect(recordQuote(record(comments[1]!))).toBe('a …');
    expect(recordQuote(record(comments[0]!))).toBe('if (expired) refresh();');
  });
});
