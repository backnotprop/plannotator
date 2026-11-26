/**
 * The canvas's byte routes (pictures' files, the board's picture, a drawing job's answer) carry the page session in
 * their query, as an upload does (api.ts `fileQuery`), so a tab left open on an older Inbox run is refused (409)
 * rather than writing into whatever runs now. What regresses: one of them sent without it.
 */
import { afterEach, expect, test } from 'bun:test';
import { resetPageSessionForTests, setPageSession } from '../api';
import { canvasApi } from './canvasApi';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetPageSessionForTests();
});

test('each byte route of the canvas names the page session', async () => {
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  setPageSession('srv_page_1');
  await canvasApi.files('msg_01K00000000000000000000001', { f1: { id: 'f1' } });
  await canvasApi.picture('msg_01K00000000000000000000001', 3, new Blob([new Uint8Array(12)]), { x: 0, y: 0, w: 10, h: 10, scale: 1 });
  await canvasApi.answerPicture(`job_${'a'.repeat(32)}`, null);
  expect(asked.length).toBe(3);
  for (const url of asked) expect(new URL(url, 'http://inbox.local').searchParams.get('serverSession')).toBe('srv_page_1');
});
