/**
 * What a failed Send says (approval "inbox-reply-box", decision D3): one plain line a person reads at a glance, and the
 * Inbox's own words (a path, an errno, a long server message) behind Details, never in the line.
 */
import { expect, test } from 'bun:test';
import { InboxApiError } from './api';
import { SEND_NOT_SENT, sendFailure } from './sendFailure';

const PATH_ERROR = "EACCES: permission denied, open '/Users/me/.plannotator/inbox/projects/ledger/threads/msg_01.jsonl'";
const FULL_ERROR = "ENOSPC: no space left on device, write '/Users/me/.plannotator/inbox/projects/ledger/threads/msg_01.jsonl'";

test('a refusal written for people (4xx, short, no path) is the line as it is, with no Details', () => {
  expect(sendFailure(new InboxApiError(409, 'question_closed', 'That question was already answered in another window.'))).toEqual({
    line: 'That question was already answered in another window.',
    details: null,
  });
});

test('a failure of the Inbox (5xx) says it could not write the reply; its own words go behind Details', () => {
  expect(sendFailure(new InboxApiError(500, 'internal', PATH_ERROR))).toEqual({
    line: 'The reply was not sent: the Inbox could not write it. Send again to retry.',
    details: PATH_ERROR,
  });
});

test('a 5xx whose words add nothing ("Internal error.") has no Details', () => {
  expect(sendFailure(new InboxApiError(500, 'internal', 'Internal error.')).details).toBeNull();
});

test('a 4xx naming a path or an errno is never the line: the line is plain, the words are the Details', () => {
  for (const words of [PATH_ERROR, 'Could not read C:\\Users\\me\\notes.md', 'EACCES while saving the reply']) {
    const failed = sendFailure(new InboxApiError(400, 'validation_error', words));
    expect(failed).toEqual({ line: 'The reply was not sent.', details: words });
  }
});

test('a 4xx too long for a line goes behind Details', () => {
  const words = `The reply could not be checked: ${'the attachment list names a file that is not in this thread, '.repeat(3)}`.trim();
  expect(words.length).toBeGreaterThan(160);
  expect(sendFailure(new InboxApiError(400, 'validation_error', words))).toEqual({ line: 'The reply was not sent.', details: words });
});

test('the disk full says so and what to do, with nothing more behind it', () => {
  expect(sendFailure(new InboxApiError(507, 'upload_no_space', FULL_ERROR))).toEqual({
    line: 'The reply was not sent: the disk is full. Free some space, then send again.',
    details: null,
  });
});

test('a reply the Inbox could not write for a full disk (ENOSPC in a 500) says the disk is full; where, behind Details', () => {
  expect(sendFailure(new InboxApiError(500, 'internal', FULL_ERROR))).toEqual({
    line: 'The reply was not sent: the disk is full. Free some space, then send again.',
    details: FULL_ERROR,
  });
});

test('no answer at all (the Inbox down, the network gone): send again; the browser\'s words behind Details', () => {
  expect(sendFailure(new TypeError('Failed to fetch'))).toEqual({ line: SEND_NOT_SENT, details: 'Failed to fetch' });
  expect(sendFailure('lost')).toEqual({ line: SEND_NOT_SENT, details: null });
});
