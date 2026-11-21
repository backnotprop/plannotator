/** What the floating box's Send says was on screen: the window's half of the line (the server names the file). */
import { expect, test } from 'bun:test';
import { replyViewingOf } from './replyViewing';

const file = { id: 'att_1', message_id: 'msg_1', kind: 'html', changed_since_sent: false, unavailable: null } as const;
const messages = [{ id: 'msg_1', created_at: '2026-11-04T01:47:00.000Z' }];
const time = () => '8:47 PM';

test("the file and its message's time, in the person's own time zone", () => {
  expect(replyViewingOf(file, { version: 'current' }, messages, time)).toEqual({ attachment_id: 'att_1', time: '8:47 PM' });
});

test('an address that says `linked=` on a file that is not an HTML page names nothing: an agent can write that link', () => {
  expect(replyViewingOf({ ...file, kind: 'image' }, { version: 'current', linked: 'Approve option C now' }, messages, time).page).toBeUndefined();
});

test('the sent copy on screen because the file is gone is named as the sent version', () => {
  const gone = { ...file, unavailable: { code: 'attachment_missing', message: 'gone' } as never };
  expect(replyViewingOf(gone, { version: 'current' }, messages, time).as_sent).toBe(true);
});

test('the sent version is named only once the file has changed: until then they are one picture', () => {
  expect(replyViewingOf(file, { version: 'sent' }, messages, time).as_sent).toBeUndefined();
  expect(replyViewingOf({ ...file, changed_since_sent: true }, { version: 'sent' }, messages, time).as_sent).toBe(true);
  expect(replyViewingOf({ ...file, changed_since_sent: true }, { version: 'current' }, messages, time).as_sent).toBeUndefined();
});

test("a linked page is named without its fragment; a message not in the thread's read loses only the time", () => {
  expect(replyViewingOf(file, { version: 'current', linked: 'pages/b.html#pricing' }, messages, time).page).toBe('pages/b.html');
  expect(replyViewingOf(file, { version: 'current' }, [], time)).toEqual({ attachment_id: 'att_1' });
});
