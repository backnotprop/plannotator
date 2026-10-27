/**
 * The feedback a Send carries for comments on running local sites (live
 * sites; packages/server/inbox-live.ts): one section per site, the comments
 * grouped by the page the store kept, in the order they were made, each with
 * the element's context; never the client's own page or location claims.
 * The server round trip (Send, wait_for_reply) is in
 * packages/server/inbox-live.test.ts.
 */
import { expect, test } from 'bun:test';
import type { InboxAnnotationRecord } from '@plannotator/core/inbox-types';
import { attachmentFeedback, isFileComment, liveSiteFeedback } from './attachments';

const SITE = { site_id: 'liv_0123456789abcdef', url: 'http://localhost:5173/' };

function live(id: string, text: string, page: string | null, at: string, extra: Record<string, unknown> = {}, site = SITE): InboxAnnotationRecord {
  return {
    id,
    project_id: 'prj_x',
    thread_id: 'msg_a',
    message_id: 'msg_a',
    attachment_id: '',
    path: site.url,
    version: 'current',
    live: { ...site, page_url: page },
    annotation: {
      id,
      blockId: 'html-element',
      startOffset: 0,
      endOffset: 0,
      type: page === null ? 'GLOBAL_COMMENT' : 'COMMENT',
      text,
      originalText: page === null ? '' : 'Cancel plan',
      createdA: 1,
      elementContext: { tag: 'button', path: 'body > main > button#cancel', role: 'button' },
      htmlAnchor: { selector: '#cancel' },
      ...extra,
    },
    created_at: at,
    updated_at: at,
    removed_at: null,
    sent_reply_id: null,
  };
}

test('one section per site, comments grouped by the stored page in the order made, each with its element; the client\'s page claim is ignored', () => {
  const records = [
    live('ann-3', 'Ask before cancelling.', '/settings', '2026-10-27T10:00:03.000Z'),
    live('ann-1', 'Say per month.', '/', '2026-10-27T10:00:01.000Z', { pageUrl: '/admin' }),
    live('ann-2', 'The whole flow is slow.', null, '2026-10-27T10:00:02.000Z'),
    live('ann-4', 'Other app.', '/', '2026-10-27T10:00:04.000Z', {}, { site_id: 'liv_fedcba9876543210', url: 'http://localhost:3000/' }),
  ];
  const text = liveSiteFeedback(records);
  const at = (part: string) => text.indexOf(part);
  expect(text.startsWith('# Feedback on your running app')).toBe(true);
  expect(at('## http://localhost:5173/ (live site)')).toBeLessThan(at('## http://localhost:3000/ (live site)'));
  expect(text).toContain("I've reviewed this site and have 3 pieces of feedback:");
  expect(text).toContain('General feedback about the site');
  expect(text).not.toContain('/admin');
  // The page-less comment first, then each page in the order its first comment was made.
  expect(at('The whole flow is slow.')).toBeLessThan(at('### Page: /\n'));
  expect(at('Say per month.')).toBeLessThan(at('### Page: /settings'));
  expect(at('### Page: /settings')).toBeLessThan(at('Ask before cancelling.'));
  expect(text).toContain('`#cancel`');
  expect(text).toContain('body > main > button#cancel');
});

test('live comments are not file comments, and ride attachmentFeedback after the files and messages', () => {
  const record = live('ann-1', 'Say per month.', '/', '2026-10-27T10:00:01.000Z');
  expect(isFileComment(record)).toBe(false);
  expect(liveSiteFeedback([])).toBe('');
  expect(attachmentFeedback([record], [], new Map(), '/work/shop')).toBe(liveSiteFeedback([record]));
});
