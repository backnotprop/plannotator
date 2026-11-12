import { afterEach, expect, test } from 'bun:test';
import { InboxApiError, InboxHeldError, inboxApi } from './api';
import { resetMachineRoutes, selfMachineId, setSelfMachine } from './inboxUrl';

const SELF = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const MINI = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAW';
const saved = globalThis.fetch;
const savedSelf = selfMachineId();
afterEach(() => {
  globalThis.fetch = saved;
  if (savedSelf === null) resetMachineRoutes();
  else setSelfMachine(savedSelf);
});

function answer(state: string) {
  const paths: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    paths.push(String(input));
    return Response.json({ outbox: { key: 'k1', machine: MINI, route: 'launch/lch_a/stop', state, queued_at: '2026-11-06T09:00:00.000Z', settled_at: null, status: null, answer: null, notice: null, dismissed: false, words: null, thread: null, machine_name: null }, machine: { id: MINI, name: 'Mini' } }, { status: 202 });
  }) as typeof fetch;
  return paths;
}

test("a held write taken back with Cancel says it was never sent; one still waiting is held", async () => {
  setSelfMachine(SELF);
  const paths = answer('cancelled');
  const cancelled = await inboxApi.launchStop('lch_a', MINI).then(() => null, (cause: unknown) => cause);
  expect(paths).toEqual([`/api/inbox/m/${MINI}/launch/lch_a/stop`]);
  expect(cancelled).toBeInstanceOf(InboxApiError);
  expect(cancelled).not.toBeInstanceOf(InboxHeldError);
  expect((cancelled as InboxApiError).message).toBe('Cancelled. It was never sent to Mini.');

  answer('queued');
  expect(await inboxApi.launchStop('lch_a', MINI).then(() => null, (cause: unknown) => cause)).toBeInstanceOf(InboxHeldError);
});

test("the test above leaves this machine's id as it found it", () => {
  expect(selfMachineId()).toBe(savedSelf);
});
