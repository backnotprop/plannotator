import { expect, test } from 'bun:test';
import type { InboxAnnotationRecord, InboxAttachmentState } from '@plannotator/core/inbox-types';
import { attachmentFeedback, exportFileLabel } from './attachments';

function inline(id: string, messageId: string, sentAt: string, ref = 'design/b.png'): InboxAttachmentState {
  return {
    id,
    ref,
    path: `/work/shop/${ref}`,
    named_path: null,
    name: ref.split('/').pop()!,
    kind: 'image',
    sent_sha256: 'a'.repeat(64),
    size: 10,
    sent_at: sentAt,
    sent_mtime: sentAt,
    message_id: messageId,
    current: null,
    changed_since_sent: false,
    unavailable: null,
  };
}

function comment(id: string, attachment: { id: string; path: string }, text: string, messageId = 'msg_a'): InboxAnnotationRecord {
  return {
    id,
    project_id: 'prj_x',
    thread_id: 'msg_a',
    message_id: messageId,
    attachment_id: attachment.id,
    path: attachment.path,
    version: 'current',
    annotation: { id, blockId: 'image', startOffset: 0, endOffset: 0, type: 'COMMENT', text, originalText: 'b.png', createdA: 1 },
    created_at: '2026-10-15T11:22:00.000Z',
    updated_at: '2026-10-15T11:22:00.000Z',
    removed_at: null,
    sent_reply_id: null,
  };
}

test('an image in a message is named by its path and the message; the same path twice in one minute gets the seconds, then its place', () => {
  const a = inline('att_a', 'msg_a', '2026-10-15T15:22:05.000Z');
  const b = inline('att_b', 'msg_b', '2026-10-15T15:22:41.000Z');
  const c = inline('att_c', 'msg_c', '2026-10-15T15:22:41.000Z');
  const lone = inline('att_l', 'msg_l', '2026-10-15T15:22:05.000Z', 'design/lone.png');
  const all = [a, b, c, lone];
  expect(exportFileLabel(lone, '/work/shop', all)).toMatch(/^design\/lone\.png \(image in your (?:\w{3} \d+, (?:\d{4}, )?)?\d{1,2}:\d{2} [AP]M message\)$/);
  expect(exportFileLabel(a, '/work/shop', all)).toMatch(/^design\/b\.png \(image in your \d{1,2}:\d{2}:05 [AP]M message\)$/);
  const labelB = exportFileLabel(b, '/work/shop', all);
  const labelC = exportFileLabel(c, '/work/shop', all);
  expect(labelB).toMatch(/:\d{2}:41 [AP]M message 1\)$/);
  expect(labelC).toMatch(/:\d{2}:41 [AP]M message 2\)$/);
  const text = attachmentFeedback([comment('c1', a, 'First.'), comment('c2', b, 'Second.', 'msg_b'), comment('c3', c, 'Third.', 'msg_c')], all, new Map(), '/work/shop');
  expect(text.match(/^## design\/b\.png/gm)).toHaveLength(3);
});

test('an image in the person\'s own message speaks as the person: "image in my … message"', () => {
  const mine = inline('att_m', 'msg_mine', '2026-10-15T15:22:05.000Z');
  const text = attachmentFeedback([comment('c1', mine, 'Like this.', 'msg_mine')], [mine], new Map(), '/work/shop', { personMessageIds: new Set(['msg_mine']) });
  expect(text).toMatch(/## design\/b\.png \(image in my (?:\w{3} \d+, (?:\d{4}, )?)?\d{1,2}:\d{2} [AP]M message\)/);
  expect(text).not.toContain('image in your');
});

test('a comment whose file the caller does not list still rides the Send, under the path it was made on', () => {
  const missing = { id: 'att_gone', path: '/work/shop/design/b.png' };
  const text = attachmentFeedback([comment('c1', missing, 'Make step 1 bold.')], [], new Map(), '/work/shop');
  expect(text).toContain('/work/shop/design/b.png');
  expect(text).toContain('Make step 1 bold.');
});
