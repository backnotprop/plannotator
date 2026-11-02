import { describe, expect, test } from 'bun:test';
import { cleanWindowRecord, debugPageId, debugRoute, isDebugRequestId, resolveInboxDebug } from './debug-log';
import { inboxId } from '@plannotator/core/inbox-types';

const MSG = 'msg_01J9Z3V5K8Q2W4E6R7T8Y9M0NP';
const PAGE = 'p1793536686632-48213';
const REQUEST = `${PAGE}-7`;

describe('what may enter the debug log', () => {
  test('a route keeps its own words and real ids; a query, a file name and a typed word do not get in', () => {
    expect(debugRoute(`/api/inbox/messages/${MSG}/reply`)).toBe(`/api/inbox/messages/${MSG}/reply`);
    expect(debugRoute(`/api/inbox/threads/${MSG}/draft/delete`)).toBe(`/api/inbox/threads/${MSG}/draft/delete`);
    expect(debugRoute(`/api/inbox/messages/${MSG}/actions/a-0123abcd-2`)).toBe(`/api/inbox/messages/${MSG}/actions/a-0123abcd-2`);
    expect(debugRoute('/api/inbox/search?q=salary+review')).toBe('/api/inbox/search');
    expect(debugRoute('/api/inbox/ref?url=https%3A%2F%2Fexample.com%2Fprivate')).toBe('/api/inbox/ref');
    expect(debugRoute('/api/inbox/embeds/salary-review.pdf')).toBe('/api/inbox/embeds/*');
    expect(debugRoute('/api/inbox/agents/Secret%20Project')).toBe('/api/inbox/agents/*');
  });

  test('every id the Inbox really makes survives in a route', () => {
    for (const prefix of ['msg', 'prj', 'ses', 'dec', 'dev', 'upl', 'drf', 'crd', 'tdy', 'ibx'] as const) {
      const id = inboxId(prefix);
      expect(debugRoute(`/api/inbox/x/${id}`)).toBe(`/api/inbox/*/${id}`);
    }
  });

  test('words dressed as an id do not get in: a known prefix is not enough', () => {
    for (const segment of ['msg_zebraquartz-the-layoffs-start-monday', 'drf_zebraquartz-my-private-note', 'att_zebraquartz-secret-file-name', 'msg_01j9z3v5k8q2w4e6r7t8y9m0np', 'msg_01J9Z3V5K8Q2W4E6R7T8Y9M0NI']) {
      expect(debugRoute(`/api/inbox/outbox/${segment}/download`)).toBe('/api/inbox/outbox/*/download');
    }
  });

  test('a window record is rebuilt from allowed fields: anything else, and any free text, is gone', () => {
    const clean = cleanWindowRecord({
      t: 1000,
      ev: 'req_start',
      page: PAGE,
      seq: 3,
      id: REQUEST,
      method: 'POST',
      route: '/api/inbox/search?q=salary',
      words: 'the words of a reply',
      body: { text: 'a draft' },
      error: 'a message with words in it',
      thread: 'my private note',
      side: 'server',
    });
    expect(clean).toEqual({ t: 1000, side: 'window', ev: 'req_start', page: PAGE, seq: 3, id: REQUEST, method: 'POST', route: '/api/inbox/search' });
  });

  test('the fields a page fills in take only their exact shape', () => {
    const words = { id: 'pthe-layoffs-start-1', page: 'pmy-private-note', error: 'Zebraquartz', protocol: 'zebra/1.1', thread: 'msg_zebraquartz-the-layoffs-start-monday', method: 'ZEBRA' };
    expect(cleanWindowRecord({ t: 1, ev: 'req_fail', ...words })).toEqual({ t: 1, side: 'window', ev: 'req_fail' });
    expect(cleanWindowRecord({ t: 1, ev: 'req_fail', error: 'TypeError', protocol: 'h2', thread: MSG, id: REQUEST })).toEqual({ t: 1, side: 'window', ev: 'req_fail', error: 'TypeError', protocol: 'h2', thread: MSG, id: REQUEST });
    // A thread is a message id, and only that.
    expect(cleanWindowRecord({ t: 1, ev: 'send_press', thread: 'a-0123abcd-2' })).toEqual({ t: 1, side: 'window', ev: 'send_press' });
  });

  test('a page id and its request ids are digits, and pass their own check', () => {
    const page = debugPageId(1793536686632.4);
    expect(page).toMatch(/^p\d+-\d+$/);
    expect(isDebugRequestId(`${page}-12`)).toBe(true);
    expect(isDebugRequestId(page)).toBe(false);
    expect(isDebugRequestId('guest-put-these-words-in-the-file')).toBe(false);
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
