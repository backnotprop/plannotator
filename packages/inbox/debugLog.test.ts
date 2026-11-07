import { describe, expect, test } from 'bun:test';
import { cleanWindowRecord, INBOX_DEBUG_BATCH_RECORDS, INBOX_DEBUG_ID_HEADER, INBOX_DEBUG_PATH } from '../shared/inbox/debug-log';
import { createDebugRecorder, DEBUG_BUFFER_RECORDS } from './debugLog';

type Rec = Record<string, unknown>;

const MSG = 'msg_01J9Z3V5K8Q2W4E6R7T8Y9M0NP';

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
    void stalled.tracked(`/api/inbox/messages/${MSG}/reply`, { method: 'POST' });
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
    expect(posted[0]!.map((r) => [r.ev, r.route])).toEqual([['req_start', `/api/inbox/messages/${MSG}/reply`]]);
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
    recorder.note('send_press', { thread: MSG });
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

  test("the window's own records pass the server's check whole: its ids stay in the shape the log allows", async () => {
    const storage = localStore();
    const recorder = createDebugRecorder({ storage, fetch: answered() as unknown as typeof fetch });
    await recorder.tracked('/api/inbox/threads');
    await tick();
    recorder.save();
    for (const record of storage.records()) {
      const clean = cleanWindowRecord(record);
      expect(clean).toMatchObject({ page: record.page as string, id: record.id as string });
    }
  });

  test('one flush sends no more than the server takes', async () => {
    const storage = localStore();
    const sizes: number[] = [];
    const recorder = createDebugRecorder({
      storage,
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        sizes.push((JSON.parse(String(init?.body)) as { records: Rec[] }).records.length);
        return new Response('{}');
      }) as typeof fetch,
    });
    for (let i = 0; i < INBOX_DEBUG_BATCH_RECORDS + 10; i += 1) recorder.note('visibility');
    await recorder.flush();
    expect(sizes).toEqual([INBOX_DEBUG_BATCH_RECORDS]);
  });

  test('the timed flush waits while a request is out, and sends once none is', async () => {
    const storage = localStore();
    const calls: string[] = [];
    let finish: (response: Response) => void = () => {};
    const recorder = createDebugRecorder({
      storage,
      fetch: ((input: RequestInfo | URL) => {
        calls.push(String(input));
        return String(input) === INBOX_DEBUG_PATH ? Promise.resolve(new Response('{}')) : new Promise<Response>((done) => (finish = done));
      }) as unknown as typeof fetch,
    });
    const hung = recorder.tracked('/api/inbox/threads');
    await recorder.flushWhenIdle();
    expect(calls).toEqual(['/api/inbox/threads']);
    finish(new Response('{}'));
    await hung;
    await tick();
    await recorder.flushWhenIdle();
    expect(calls).toEqual(['/api/inbox/threads', INBOX_DEBUG_PATH]);
  });
});

describe('the wrapper changes nothing about the request', () => {
  const seen = (): { input: RequestInfo | URL; init: RequestInit | undefined }[] => [];

  test("the caller gets the fetch's own response object, not a copy", async () => {
    const answer = new Response('{"ok":true}', { status: 201 });
    const recorder = createDebugRecorder({ storage: localStore(), fetch: (async () => answer) as unknown as typeof fetch });
    const got = await recorder.tracked('/api/inbox/threads');
    expect(got).toBe(answer);
    expect(await got.json()).toEqual({ ok: true });
  });

  test("the caller gets the fetch's own error object", async () => {
    const failure = new TypeError('Load failed');
    const recorder = createDebugRecorder({ storage: localStore(), fetch: (async () => Promise.reject(failure)) as unknown as typeof fetch });
    const got = await recorder.tracked('/api/inbox/threads').then(
      () => 'resolved',
      (cause: unknown) => cause,
    );
    expect(got).toBe(failure);
  });

  test('an abort comes back as the same error too', async () => {
    const abort = new DOMException('stopped', 'AbortError');
    const recorder = createDebugRecorder({ storage: localStore(), fetch: (async () => Promise.reject(abort)) as unknown as typeof fetch });
    expect(await recorder.tracked('/api/inbox/threads').catch((cause: unknown) => cause)).toBe(abort);
  });

  test('one call, made in the same tick: no retry after a failure, and no delay before sending', async () => {
    const calls = seen();
    const recorder = createDebugRecorder({
      storage: localStore(),
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return Promise.reject(new TypeError('Load failed'));
      }) as unknown as typeof fetch,
    });
    const going = recorder.tracked('/api/inbox/threads');
    expect(calls).toHaveLength(1);
    await going.catch(() => {});
    await new Promise((done) => setTimeout(done, 20));
    expect(calls).toHaveLength(1);
  });

  test('the url and every option arrive as given, with the signal the same object, and only the id added to the headers', async () => {
    const calls = seen();
    const recorder = createDebugRecorder({
      storage: localStore(),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return new Response('{}');
      }) as unknown as typeof fetch,
    });
    const signal = new AbortController().signal;
    const body = JSON.stringify({ words: 'private words' });
    await recorder.tracked('/api/inbox/threads?x=1', { method: 'POST', body, signal, keepalive: true, cache: 'no-store', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } });
    expect(calls).toHaveLength(1);
    const { input, init } = calls[0]!;
    expect(input).toBe('/api/inbox/threads?x=1');
    expect(init?.signal).toBe(signal);
    expect(init).toMatchObject({ method: 'POST', body, keepalive: true, cache: 'no-store', credentials: 'same-origin' });
    const headers = new Headers(init?.headers);
    expect(headers.get('content-type')).toBe('application/json');
    headers.delete(INBOX_DEBUG_ID_HEADER);
    expect([...headers.keys()]).toEqual(['content-type']);
  });

  test('a Request keeps its own headers, and is passed on as the same object', async () => {
    const calls = seen();
    const recorder = createDebugRecorder({
      storage: localStore(),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return new Response('{}');
      }) as unknown as typeof fetch,
    });
    const request = new Request('http://inbox.invalid/api/inbox/threads', { headers: { Accept: 'application/json' } });
    await recorder.tracked(request);
    expect(calls[0]!.input).toBe(request);
    expect(new Headers(calls[0]!.init?.headers).get('accept')).toBe('application/json');
  });

  test("a recording failure before sending falls back to the plain fetch, once, with the caller's own arguments", async () => {
    const calls = seen();
    const answer = new Response('{}');
    const recorder = createDebugRecorder({
      storage: localStore(),
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return answer;
      }) as unknown as typeof fetch,
    });
    const init = { headers: { 'bad header': 'x' } };
    let going: Promise<Response> | undefined;
    expect(() => (going = recorder.tracked('/api/inbox/threads', init))).not.toThrow();
    expect(await going).toBe(answer);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init).toBe(init);
    expect(recorder.openRequests()).toBe(0);
  });

  test('a recording failure after the answer changes nothing: the same response, and the same error', async () => {
    let broken = false;
    const now = () => {
      if (broken) throw new Error('no clock');
      return 1;
    };
    const answer = new Response('{}');
    const answering = createDebugRecorder({
      storage: localStore(),
      now,
      fetch: (async () => {
        broken = true;
        return answer;
      }) as unknown as typeof fetch,
    });
    expect(await answering.tracked('/api/inbox/threads')).toBe(answer);
    expect(answering.openRequests()).toBe(0);

    broken = false;
    const failure = new TypeError('Load failed');
    const failing = createDebugRecorder({
      storage: localStore(),
      now,
      fetch: (async () => {
        broken = true;
        throw failure;
      }) as unknown as typeof fetch,
    });
    expect(await failing.tracked('/api/inbox/threads').catch((cause: unknown) => cause)).toBe(failure);
  });

  test('a response that cannot be copied still reaches the caller', async () => {
    const storage = localStore();
    const answer = new Response('{}');
    await answer.text();
    const recorder = createDebugRecorder({ storage, fetch: (async () => answer) as unknown as typeof fetch });
    expect(await recorder.tracked('/api/inbox/threads')).toBe(answer);
    expect(recorder.openRequests()).toBe(0);
  });

  test('a body that fails after the head does not touch the response the caller holds', async () => {
    const storage = localStore();
    const answer = new Response(new ReadableStream({ start: (controller) => controller.error(new TypeError('cut')) }));
    const recorder = createDebugRecorder({ storage, fetch: (async () => answer) as unknown as typeof fetch });
    expect(await recorder.tracked('/api/inbox/threads')).toBe(answer);
    await tick();
    recorder.save();
    expect(storage.records().map((r) => r.ev)).toEqual(['req_start', 'req_head', 'req_fail']);
  });
});
