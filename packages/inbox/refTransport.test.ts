import { expect, test } from 'bun:test';
import type { ForgeRef } from '@plannotator/core/forge-ref-card';
import { inboxRefTransport } from './refTransport';

const ref = { platform: 'github', host: 'github.com', owner: 'acme', repo: 'web', kind: 'pull', number: 1 } as unknown as ForgeRef;
const signal = new AbortController().signal;

function server(status: number) {
  const asked: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const get = async (href: string) => {
    asked.push(href);
    await gate;
    return new Response(JSON.stringify({ ok: true, data: {}, fetchedAt: 1 }), { status });
  };
  return { asked, release, transport: inboxRefTransport(get) };
}

test('refused: rows on screen together send one request, and none after', async () => {
  const { asked, release, transport } = server(404);
  const rows = ['a', 'b', 'c', 'd'].map((n) => transport(`https://github.com/acme/web/pull/${n}`, ref, signal));
  await Promise.resolve();
  expect(asked.length).toBe(1);
  release();
  expect(await Promise.all(rows)).toEqual([null, null, null, null]);
  expect(await transport('https://github.com/acme/web/pull/e', ref, signal)).toBeNull();
  expect(asked.length).toBe(1);
});

test('answered: the rest ask, each its own link', async () => {
  const { asked, release, transport } = server(200);
  const rows = ['a', 'b', 'c'].map((n) => transport(`https://github.com/acme/web/pull/${n}`, ref, signal));
  release();
  const answers = await Promise.all(rows);
  expect(answers.every((a) => a?.ok === true)).toBe(true);
  expect(asked.length).toBe(3);
});
