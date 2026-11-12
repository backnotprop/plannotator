import { expect, test } from 'bun:test';
import type { InboxAskModel } from '../api';
import { createAskReader } from './askReads';

function server() {
  const sent: Array<{ thread: string; answer: (n?: number) => void; fail: () => void }> = [];
  const read = (thread: string) =>
    new Promise<InboxAskModel>((resolve, reject) => {
      const n = sent.length + 1;
      sent.push({ thread, answer: () => resolve({ running: null, can_ask: true, conversation: null, n } as unknown as InboxAskModel), fail: () => reject(new Error('offline')) });
    });
  return { sent, read };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const nOf = (model: InboxAskModel) => (model as unknown as { n: number }).n;

test('calls in the same task share one read, and each gets its answer', async () => {
  const s = server();
  const readAsk = createAskReader(s.read);
  const calls = [readAsk('thr_1'), readAsk('thr_1'), readAsk('thr_1')];
  await tick();
  expect(s.sent).toHaveLength(1);
  s.sent[0]!.answer();
  expect((await Promise.all(calls)).map(nOf)).toEqual([1, 1, 1]);
});

test('a change during a read: a call then reads again at once, shared by its task, with the newer answer', async () => {
  const s = server();
  const readAsk = createAskReader(s.read);
  const first = readAsk('thr_1');
  await tick();
  expect(s.sent).toHaveLength(1);

  const during = [readAsk('thr_1'), readAsk('thr_1')];
  await tick();
  expect(s.sent).toHaveLength(2);

  s.sent[1]!.answer();
  expect((await Promise.all(during)).map(nOf)).toEqual([2, 2]);
  s.sent[0]!.answer();
  expect(nOf(await first)).toBe(1);

  await tick();
  expect(s.sent).toHaveLength(2);
});

test('a read that fails: its callers hear it, and the next call reads again', async () => {
  const s = server();
  const readAsk = createAskReader(s.read);
  const failed = readAsk('thr_1');
  await tick();
  s.sent[0]!.fail();
  await expect(failed).rejects.toThrow('offline');
  const again = readAsk('thr_1');
  await tick();
  expect(s.sent).toHaveLength(2);
  s.sent[1]!.answer();
  expect(nOf(await again)).toBe(2);
});

test('each thread reads on its own', async () => {
  const s = server();
  const readAsk = createAskReader(s.read);
  const one = readAsk('thr_1');
  const two = readAsk('thr_2');
  await tick();
  expect(s.sent.map((read) => read.thread)).toEqual(['thr_1', 'thr_2']);
  for (const read of s.sent) read.answer();
  expect([nOf(await one), nOf(await two)]).toEqual([1, 2]);
});
