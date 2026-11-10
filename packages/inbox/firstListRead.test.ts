/**
 * The window's first list read, tried again while it fails (firstListRead.ts).
 * Before it, one failed first read left the page without its live stream until
 * a reload. Failures to catch: giving up after a failed read; reading again
 * after the page left or after the Inbox refused the page; reading once more
 * when another read already brought the list; a refusal read as a failure
 * worth retrying, or a dropped connection read as a refusal.
 */
import { expect, test } from 'bun:test';
import { FIRST_LIST_RETRY_MS, listReadRefused, readFirstList } from './firstListRead';

function world(answers: (string | null)[]) {
  const waits: number[] = [];
  const state = { reads: 0, cancelled: false, refused: false, landed: null as string | null, late: 0 };
  const deps = {
    read: async () => answers[state.reads++] ?? null,
    landed: () => state.landed,
    refused: () => state.refused,
    cancelled: () => state.cancelled,
    wait: async (ms: number) => {
      waits.push(ms);
    },
    onLateLanding: () => {
      state.late += 1;
    },
  };
  return { waits, state, deps };
}

test('a first read that lands is read once, with no wait', async () => {
  const { waits, state, deps } = world(['list']);
  expect(await readFirstList(deps)).toBe('list');
  expect(state.reads).toBe(1);
  expect(waits).toEqual([]);
  expect(state.late).toBe(0);
});

test('a first read that fails is read again until it lands, on the waits, the last one repeating', async () => {
  const fails = FIRST_LIST_RETRY_MS.length + 2;
  const { waits, state, deps } = world([...Array<null>(fails).fill(null), 'list']);
  expect(await readFirstList(deps)).toBe('list');
  expect(state.reads).toBe(fails + 1);
  const last = FIRST_LIST_RETRY_MS[FIRST_LIST_RETRY_MS.length - 1]!;
  expect(waits).toEqual([...FIRST_LIST_RETRY_MS, last, last]);
  // What failed with the first read (the settings) is read again, once.
  expect(state.late).toBe(1);
});

test('the page left while it waited: nothing more is read', async () => {
  const { state, deps } = world([null, 'list']);
  const first = readFirstList({
    ...deps,
    wait: async () => {
      state.cancelled = true;
    },
  });
  expect(await first).toBeNull();
  expect(state.reads).toBe(1);
});

test('the Inbox refused the page: not read again', async () => {
  const { waits, state, deps } = world([null, 'list']);
  state.refused = true;
  expect(await readFirstList(deps)).toBeNull();
  expect(state.reads).toBe(1);
  expect(waits).toEqual([]);
});

test('another read brought the list meanwhile: it is taken, and the list is not read again', async () => {
  const { state, deps } = world([null, 'second read']);
  const first = readFirstList({
    ...deps,
    wait: async () => {
      state.landed = 'the look\'s read';
    },
  });
  expect(await first).toBe('the look\'s read');
  expect(state.reads).toBe(1);
});

test('only the Inbox\'s own refusal stops the retries', () => {
  expect(listReadRefused({ status: 403 })).toBe(true);
  expect(listReadRefused({ status: 404 })).toBe(true);
  // A dropped connection, a server error, "too many", and a timeout are tried again.
  expect(listReadRefused(new TypeError('Failed to fetch'))).toBe(false);
  expect(listReadRefused({ status: 500 })).toBe(false);
  expect(listReadRefused({ status: 503 })).toBe(false);
  expect(listReadRefused({ status: 429 })).toBe(false);
  expect(listReadRefused({ status: 408 })).toBe(false);
  expect(listReadRefused(null)).toBe(false);
});
