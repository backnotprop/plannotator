import { describe, expect, test } from 'bun:test';
import { INBOX_DEBUG_ID_HEADER, INBOX_DEBUG_PATH } from '@plannotator/core/inbox-debug-log';
import { createDebugRecorder, DEBUG_BUFFER_RECORDS } from './debugLog';

type Rec = Record<string, unknown>;

function localStore() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    records: (): Rec[] => JSON.parse(values.get('plannotator-inbox-debug-buffer') ?? '[]') as Rec[],
    size: () => values.size,
  };
}

const answered = (status = 200) => async () => new Response('{}', { status });
const never = () => new Promise<Response>(() => {});
const tick = () => new Promise((done) => setTimeout(done, 0));

describe('the window recorder', () => {
  test('a request is noted from start to end, with an id on the request itself, and no body or query', async () => {
    const storage = localStore();
    let sent: Headers | null = null;
    const recorder = createDebugRecorder({
      storage,
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        sent = new Headers(init?.headers);
        return new Response('{}');
      }) as typeof fetch,
    });
    await recorder.tracked('/api/inbox/search?q=private+words', { method: 'POST', body: JSON.stringify({ words: 'private words' }) });
    await tick();
    recorder.save();
    const records = storage.records();
    expect(records.map((r) => r.ev)).toEqual(['req_start', 'req_head', 'req_end']);
    expect(records[0]).toMatchObject({ method: 'POST', route: '/api/inbox/search' });
    expect(records[2]).toMatchObject({ status: 200 });
    expect(sent!.get(INBOX_DEBUG_ID_HEADER)).toBe(records[0]!.id as string);
    expect(JSON.stringify(records)).not.toContain('private');
  });

  test('a request that never answers leaves a start in the buffer, for the next page', async () => {
    const storage = localStore();
    const stalled = createDebugRecorder({ storage, fetch: never as unknown as typeof fetch });
    void stalled.tracked('/api/inbox/messages/msg_abc123XYZ/reply', { method: 'POST' });
    stalled.save();
    expect(stalled.openRequests()).toBe(1);

    // The refresh: a new page, the same buffer, and the Inbox reachable again.
    const posted: Rec[][] = [];
    const next = createDebugRecorder({
      storage,
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        posted.push((JSON.parse(String(init?.body)) as { records: Rec[] }).records);
        return new Response('{}');
      }) as typeof fetch,
    });
    await next.flush();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.map((r) => [r.ev, r.route])).toEqual([['req_start', '/api/inbox/messages/msg_abc123XYZ/reply']]);
    expect(storage.records()).toEqual([]);
  });

  test('a flush with no way through keeps the records for the next try, and the flush is not itself recorded', async () => {
    const storage = localStore();
    const urls: string[] = [];
    const recorder = createDebugRecorder({
      storage,
      fetch: (async (input: RequestInfo | URL) => {
        urls.push(String(input));
        throw new TypeError('Load failed');
      }) as unknown as typeof fetch,
    });
    recorder.note('send_press', { thread: 'msg_abc123XYZ' });
    await recorder.flush();
    expect(urls).toEqual([INBOX_DEBUG_PATH]);
    expect(storage.records().map((r) => r.ev)).toEqual(['send_press']);
  });

  test('an aborted request and a failed one say so', async () => {
    const storage = localStore();
    const abort = new DOMException('stopped', 'AbortError');
    let answer: () => Promise<Response> = async () => Promise.reject(abort);
    const recorder = createDebugRecorder({ storage, fetch: (() => answer()) as unknown as typeof fetch });
    await recorder.tracked('/api/inbox/threads').catch(() => {});
    answer = async () => Promise.reject(new TypeError('Load failed'));
    await recorder.tracked('/api/inbox/threads').catch(() => {});
    recorder.save();
    expect(storage.records().map((r) => [r.ev, r.error])).toEqual([
      ['req_start', undefined],
      ['req_abort', 'AbortError'],
      ['req_start', undefined],
      ['req_fail', 'TypeError'],
    ]);
  });

  test('a body that stalls is not an end: the answer started, and that is all that shows', async () => {
    const storage = localStore();
    const recorder = createDebugRecorder({ storage, fetch: (async () => new Response(new ReadableStream({ start() {} }))) as unknown as typeof fetch });
    await recorder.tracked('/api/inbox/threads');
    await tick();
    recorder.save();
    expect(storage.records().map((r) => r.ev)).toEqual(['req_start', 'req_head']);
  });

  test('the buffer is capped: the oldest go, and a line says how many', () => {
    const storage = localStore();
    const recorder = createDebugRecorder({ storage, fetch: never as unknown as typeof fetch });
    for (let i = 0; i < DEBUG_BUFFER_RECORDS + 50; i += 1) recorder.note('visibility', { n: i });
    recorder.save();
    const records = storage.records();
    expect(records).toHaveLength(DEBUG_BUFFER_RECORDS);
    expect(records.at(-1)).toMatchObject({ ev: 'buffer_dropped', n: 51 });
  });

  test('debug turned off at the server: the route is gone, so the buffer and the switch are cleared and nothing more is kept', async () => {
    const storage = localStore();
    const recorder = createDebugRecorder({ storage, fetch: answered(404) as unknown as typeof fetch });
    recorder.note('page_load');
    await recorder.flush();
    expect(storage.size()).toBe(0);
    recorder.note('page_show');
    recorder.save();
    expect(storage.size()).toBe(0);
  });

  test('requests that are not the Inbox API pass through untouched', async () => {
    const storage = localStore();
    let init: RequestInit | undefined;
    const recorder = createDebugRecorder({
      storage,
      fetch: (async (_input: RequestInfo | URL, given?: RequestInit) => {
        init = given;
        return new Response('{}');
      }) as typeof fetch,
    });
    await recorder.tracked('/assets/app.css', { cache: 'no-store' });
    recorder.save();
    expect(storage.size()).toBe(0);
    expect(new Headers(init?.headers).has(INBOX_DEBUG_ID_HEADER)).toBe(false);
  });
});
