import { expect, test } from 'bun:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { DRAW_GAP_MS, drawSoon } from './drawGap';

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

function watched() {
  const client = new QueryClient();
  const key = ['inbox', 'thread', 't1'];
  client.setQueryData<number[]>(key, []);
  const observer = new QueryObserver<number[]>(client, { queryKey: key, enabled: false, notifyOnChangeProps: ['data'] });
  const seen: number[][] = [];
  let inTask = false;
  const stop = observer.subscribe(() => {
    if (inTask) return;
    inTask = true;
    setTimeout(() => {
      inTask = false;
      seen.push(client.getQueryData<number[]>(key) ?? []);
    }, 0);
  });
  const add = (n: number) => drawSoon(() => client.setQueryData<number[]>(key, (held = []) => [...held, n]));
  return { client, key, seen, add, stop };
}

test('records that come together draw together: a message is never drawn without the records written with it', async () => {
  await wait(DRAW_GAP_MS + 20);
  const { client, key, seen, add, stop } = watched();
  add(1);
  await wait(1);
  add(2);
  add(3);
  expect(client.getQueryData(key)).toEqual([]);
  await wait(DRAW_GAP_MS);
  expect(seen).toEqual([[1, 2, 3]]);
  stop();
  client.clear();
});

test('a steady stream of records redraws at most once per gap, not once per record', async () => {
  await wait(DRAW_GAP_MS + 20);
  const { client, key, seen, add, stop } = watched();
  const count = Math.floor(DRAW_GAP_MS / 10) * 2;
  for (let n = 1; n <= count; n++) {
    add(n);
    await wait(5);
  }
  await wait(DRAW_GAP_MS + 50);
  expect(client.getQueryData(key)).toEqual(Array.from({ length: count }, (_, i) => i + 1));
  expect(seen.length).toBeLessThanOrEqual(3);
  stop();
  client.clear();
});
