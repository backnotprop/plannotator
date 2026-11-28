/**
 * The feedback a Send carries for images a message shows (approval
 * "inbox-image-viewer"): named by the path as written plus the message it was
 * in; two messages showing the same path within one minute never share a
 * heading; and a comment whose file the caller did not list (an older phone
 * app that does not know `inline_images`) still rides the Send under the path
 * it was made on, never dropped while it is marked sent.
 */
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
  // Each picture keeps its own section in the feedback.
  const text = attachmentFeedback([comment('c1', a, 'First.'), comment('c2', b, 'Second.', 'msg_b'), comment('c3', c, 'Third.', 'msg_c')], all, new Map(), '/work/shop');
  expect(text.match(/^## design\/b\.png/gm)).toHaveLength(3);
});

test('an image in the person\'s own message speaks as the person: "image in my … message"', () => {
  const mine = inline('att_m', 'msg_mine', '2026-10-15T15:22:05.000Z');
  const text = attachmentFeedback([comment('c1', mine, 'Like this.', 'msg_mine')], [mine], new Map(), '/work/shop', { personMessageIds: new Set(['msg_mine']) });
  expect(text).toMatch(/## design\/b\.png \(image in my (?:\w{3} \d+, (?:\d{4}, )?)?\d{1,2}:\d{2} [AP]M message\)/);
  expect(text).not.toContain('image in your');
});

test('a comment at a moment of a video the text plays is headed "video in your … message", with its "At m:ss" line', () => {
  const film: InboxAttachmentState = { ...inline('att_v', 'msg_a', '2026-10-15T15:22:05.000Z', 'media/walkthrough.webm'), kind: 'video', media_type: 'video/webm', duration_ms: 5_000 };
  const record = comment('c1', film, 'Hold on the berth change.');
  record.annotation = { ...record.annotation, blockId: 'video', inboxVideo: { time: 2.2 } } as InboxAnnotationRecord['annotation'];
  const text = attachmentFeedback([record], [film], new Map(), '/work/shop');
  expect(text).toMatch(/^## media\/walkthrough\.webm \(video in your (?:\w{3} \d+, (?:\d{4}, )?)?\d{1,2}:\d{2} [AP]M message\)$/m);
  expect(text).toContain('At 0:02 (2.2 s of 0:05)');
  expect(text).toContain('the files you attached and the videos your messages showed,');
  expect(text).not.toContain('image in your');

  // A sound: "sound in"; a picture beside them keeps "image in", and the intro names each kind there is.
  const sound: InboxAttachmentState = { ...inline('att_s', 'msg_a', '2026-10-15T15:22:05.000Z', 'media/standup.wav'), kind: 'audio' };
  const picture = inline('att_p', 'msg_a', '2026-10-15T15:22:05.000Z');
  const both = attachmentFeedback([comment('c2', sound, 'Too quiet.'), comment('c3', picture, 'Bigger.')], [sound, picture], new Map(), '/work/shop');
  expect(both).toMatch(/^## media\/standup\.wav \(sound in your /m);
  expect(both).toMatch(/^## design\/b\.png \(image in your /m);
  expect(both).toContain('the images and sounds your messages showed or played');
});

test('pictures only keep the intro as it was', () => {
  const picture = inline('att_p', 'msg_a', '2026-10-15T15:22:05.000Z');
  const text = attachmentFeedback([comment('c1', picture, 'Bigger.')], [picture], new Map(), '/work/shop');
  expect(text).toContain('The following feedback is on the files you attached and the images your messages showed, one section per file and version.');
});

test('a comment whose file the caller does not list still rides the Send, under the path it was made on', () => {
  const missing = { id: 'att_gone', path: '/work/shop/design/b.png' };
  const text = attachmentFeedback([comment('c1', missing, 'Make step 1 bold.')], [], new Map(), '/work/shop');
  expect(text).toContain('/work/shop/design/b.png');
  expect(text).toContain('Make step 1 bold.');
});
