/**
 * A read whose body is lost after its headers (the page leaving mid-read in Firefox, the Inbox restarting, a cut
 * connection). The failure this catches: readJson read the lost body as `{}` and handed it on as the answer, so the
 * agents read kept `{}` as the model and the agent-note dialog's check (`noteQuestionRows`) threw "can't access
 * property "filter", model.agents is undefined" inside a React effect (seen in CI as a page error in Firefox,
 * inbox-review-plus-button-firefox.spec.ts). Now the lost body fails the read, and a read without the agents list is
 * never kept.
 */
import { afterEach, expect, test } from 'bun:test';
import { inboxApi } from './api';
import { readJson } from './apiError';
import { agentsRead, noteQuestionRows } from './agents';
import type { InboxAgentsModel } from '@plannotator/core/inbox-types';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A 200 whose headers came and whose body then broke off, as a browser aborts a page's reads when it leaves. */
function cutAnswer(): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"agents":[{"id":"cod'));
      controller.error(new DOMException('The operation was aborted.', 'AbortError'));
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('a 200 whose body broke off fails the read; it is never an empty answer', async () => {
  await expect(readJson(cutAnswer())).rejects.toThrow('aborted');
});

test('an empty or unparsable OK body still reads as {} (a 204, a bare 200)', async () => {
  expect(await readJson(new Response(null, { status: 204 }))).toEqual({});
  expect(await readJson(new Response('', { status: 200 }))).toEqual({});
});

test('the agents read with its body cut fails, so the dialog never checks a model without its list', async () => {
  globalThis.fetch = (async () => cutAnswer()) as unknown as typeof fetch;
  // Before the fix this resolved to {}, and noteQuestionRows({}) threw inside the window's effect.
  await expect(inboxApi.agents()).rejects.toThrow('aborted');
  expect(() => noteQuestionRows({} as InboxAgentsModel)).toThrow();
});

test('a read without the agents list is refused; one with it is kept as it came', () => {
  expect(() => agentsRead({} as InboxAgentsModel)).toThrow(TypeError);
  expect(() => agentsRead(null as unknown as InboxAgentsModel)).toThrow(TypeError);
  const model = { agents: [] } as unknown as InboxAgentsModel;
  expect(agentsRead(model)).toBe(model);
});
