/**
 * The pictures and files added to a comment on an image or a film (commentFiles.tsx) beside its drawing or frame:
 * the drawing is still the one laid over the image and drawn on the card, the added ones never are, and the
 * feedback names both under the comment, the added ones by their file name (the reply's attachments).
 */
import { expect, test } from 'bun:test';
import type { InboxAnnotationRecord } from '@plannotator/core/inbox-types';
import { attachmentFeedback, imageCommentAnnotation } from './attachments';
import { commentImageOf, withPictures } from './commentPictureFiles';
import { addedToComment, isWordlessMarkup, markupOf, MARKUP_ONLY_TEXT } from './markup';

const UPL = 'upl_01JD2Q9V8Y6K3M4N5P7R8S9T0V';
const UPL2 = 'upl_01JD2Q9V8Y6K3M4N5P7R8S9T0W';
const drawing = { path: '/data/inbox/markups/3f2a.png', name: 'shot, marked up' };
const picture = commentImageOf({ upload_id: UPL, name: 'legend.png', kind: 'image' });
const notes = commentImageOf({ upload_id: UPL2, name: 'notes.txt', kind: 'text' });

test('an upload goes on the comment by its path: a picture by its name, any other file as a file', () => {
  expect(picture).toEqual({ path: `${UPL}/legend.png`, name: 'legend' });
  expect(notes).toEqual({ path: `${UPL2}/notes.txt`, name: 'notes.txt', kind: 'file' });
});

test('the drawing is the one laid over the image, wherever the added pictures sit; pictures alone are no drawing', () => {
  expect(markupOf({ images: [picture, drawing, notes] })).toEqual(drawing);
  expect(markupOf({ images: [picture, notes] })).toBeNull();
  expect(addedToComment({ images: [drawing, picture, notes] })).toEqual([picture, notes]);
});

test('a drawing with no words is drawn as its picture; with pictures added it is a comment that shows them', () => {
  expect(isWordlessMarkup({ text: MARKUP_ONLY_TEXT, images: [drawing] })).toBe(true);
  expect(isWordlessMarkup({ text: MARKUP_ONLY_TEXT, images: [drawing, picture] })).toBe(false);
  expect(isWordlessMarkup({ text: '', images: [picture] })).toBe(false);
});

test('the feedback names the drawing and the added picture and file under the comment, and the Send carries the uploads', () => {
  const annotation = imageCommentAnnotation({ id: 'ann-img-1', name: 'shot.png', text: 'The legend is cut off.', markup: drawing });
  const record: InboxAnnotationRecord = {
    id: 'ann-img-1',
    project_id: 'prj_1',
    thread_id: 'thr_1',
    message_id: 'msg_1',
    attachment_id: 'att_1',
    path: '/work/shot.png',
    version: 'current',
    annotation: { ...annotation, images: [drawing, picture, notes] } as unknown as Record<string, unknown>,
    created_at: '2026-11-22T10:00:00.000Z',
    updated_at: '2026-11-22T10:00:00.000Z',
    removed_at: null,
    sent_reply_id: null,
  };
  const text = attachmentFeedback([record], [], new Map(), '/work');
  expect(text).toContain(
    '> The legend is cut off.\n**Attached images:**\n- [shot, marked up] `/data/inbox/markups/3f2a.png`\n- [legend] `legend.png`\n**Attached files:**\n- [notes.txt] `notes.txt`\n',
  );
  expect(withPictures([], [record]).sort()).toEqual([UPL, UPL2]);
});
