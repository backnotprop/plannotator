import { describe, expect, test } from 'bun:test';
import { ownAttachmentInPaste } from './reusePaste';

const ORIGIN = 'http://localhost:4000';
const ID = 'att_01M6MNRB6S4906APPHXF7W47SN';
const clip = (html: string) => ({ getData: (type: string) => (type === 'text/html' ? html : '') });

describe('a pasted picture that is this Inbox\'s own file', () => {
  test.each([
    ['Chrome', `<meta charset="utf-8"><img src="${ORIGIN}/api/inbox/attachments/${ID}/image" alt="ref02.jpg"/>`],
    ['Windows fragment comments', `<html><body><!--StartFragment--><img src="${ORIGIN}/api/inbox/attachments/${ID}/image"><!--EndFragment--></body></html>`],
    ['a relative src', `<img src="/api/inbox/attachments/${ID}/image">`],
    ['single quotes', `<img alt='x' src='${ORIGIN}/api/inbox/attachments/${ID}/image'>`],
  ])('%s', (_, html) => {
    expect(ownAttachmentInPaste(clip(html), ORIGIN)).toEqual({ id: ID, version: 'current', src: `/api/inbox/attachments/${ID}/image` });
  });

  test('the sent version stays the sent version', () => {
    expect(ownAttachmentInPaste(clip(`<img src="${ORIGIN}/api/inbox/attachments/${ID}/image?version=sent">`), ORIGIN)?.version).toBe('sent');
  });
});

describe('anything else is a plain paste', () => {
  test.each([
    ['nothing on the clipboard', ''],
    ['words only', '<p>some words</p>'],
    ['words around the picture', `<p>See this <img src="${ORIGIN}/api/inbox/attachments/${ID}/image"> here</p>`],
    ['two pictures', `<img src="${ORIGIN}/api/inbox/attachments/${ID}/image"><img src="${ORIGIN}/api/inbox/attachments/${ID}/image">`],
    ['another Inbox', `<img src="http://localhost:5000/api/inbox/attachments/${ID}/image">`],
    ['another site', `<img src="https://example.com/api/inbox/attachments/${ID}/image">`],
    ['a linked machine\'s file', `<img src="${ORIGIN}/api/inbox/m/ibx_other/attachments/${ID}/image">`],
    ['another route', `<img src="${ORIGIN}/api/inbox/attachments/${ID}/download">`],
    ['not an attachment id', `<img src="${ORIGIN}/api/inbox/attachments/nope/image">`],
    ['a data URL', '<img src="data:image/png;base64,AAAA">'],
  ])('%s', (_, html) => {
    expect(ownAttachmentInPaste(clip(html), ORIGIN)).toBeNull();
  });

  test('a clipboard that throws, and none at all', () => {
    expect(ownAttachmentInPaste({ getData: () => { throw new Error('denied'); } }, ORIGIN)).toBeNull();
    expect(ownAttachmentInPaste(null, ORIGIN)).toBeNull();
  });
});
