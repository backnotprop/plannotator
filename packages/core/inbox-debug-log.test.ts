import { describe, expect, test } from 'bun:test';
import { cleanWindowRecord, debugRoute, resolveInboxDebug } from './inbox-debug-log';

describe('what may enter the debug log', () => {
  test('a route keeps its own words and ids; a query, a file name and a typed word do not get in', () => {
    expect(debugRoute('/api/inbox/messages/msg_abc123XYZ/reply')).toBe('/api/inbox/messages/msg_abc123XYZ/reply');
    expect(debugRoute('/api/inbox/threads/msg_abc123XYZ/draft/delete')).toBe('/api/inbox/threads/msg_abc123XYZ/draft/delete');
    expect(debugRoute('/api/inbox/messages/msg_abc123XYZ/actions/a-0123abcd-2')).toBe('/api/inbox/messages/msg_abc123XYZ/actions/a-0123abcd-2');
    expect(debugRoute('/api/inbox/search?q=salary+review')).toBe('/api/inbox/search');
    expect(debugRoute('/api/inbox/ref?url=https%3A%2F%2Fexample.com%2Fprivate')).toBe('/api/inbox/ref');
    expect(debugRoute('/api/inbox/embeds/salary-review.pdf')).toBe('/api/inbox/embeds/*');
    expect(debugRoute('/api/inbox/agents/Secret%20Project')).toBe('/api/inbox/agents/*');
  });

  test('a window record is rebuilt from allowed fields: anything else, and any free text, is gone', () => {
    const clean = cleanWindowRecord({
      t: 1000,
      ev: 'req_start',
      page: 'p1-abc',
      seq: 3,
      id: 'p1-abc-7',
      method: 'POST',
      route: '/api/inbox/search?q=salary',
      words: 'the words of a reply',
      body: { text: 'a draft' },
      error: 'a message with words in it',
      thread: 'my private note',
      side: 'server',
    });
    expect(clean).toEqual({ t: 1000, side: 'window', ev: 'req_start', page: 'p1-abc', seq: 3, id: 'p1-abc-7', method: 'POST', route: '/api/inbox/search' });
  });

  test('what is not a window record is dropped', () => {
    expect(cleanWindowRecord({ t: 1, ev: 'anything else' })).toBeNull();
    expect(cleanWindowRecord({ ev: 'page_load' })).toBeNull();
    expect(cleanWindowRecord('page_load')).toBeNull();
  });

  test('on with the env value 1 or the config true, and nothing else', () => {
    expect(resolveInboxDebug({}, {})).toBe(false);
    expect(resolveInboxDebug({}, { PLANNOTATOR_INBOX_DEBUG: '1' })).toBe(true);
    expect(resolveInboxDebug({}, { PLANNOTATOR_INBOX_DEBUG: 'true' })).toBe(false);
    expect(resolveInboxDebug({ inboxDebug: true }, {})).toBe(true);
    expect(resolveInboxDebug({ inboxDebug: 'yes' }, {})).toBe(false);
  });
});
