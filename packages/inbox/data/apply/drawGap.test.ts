import { expect, test } from 'bun:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { DRAW_GAP_MS, drawSoon } from './drawGap';

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

test('a burst of records redraws the open thread twice (the first at once, the rest together), not once per record', async () => {
  const client = new QueryClient();
  const key = ['inbox', 'thread', 't1'];
  client.setQueryData<number[]>(key, []);
  const observer = new QueryObserver<number[]>(client, { queryKey: key, enabled: false, notifyOnChangeProps: ['data'] });
  // React draws once per task that changed the store, however many changes the task held.
  let redraws = 0;
  let inTask = false;
  const stop = observer.subscribe(() => {
    if (inTask) return;
    inTask = true;
    redraws += 1;
    setTimeout(() => (inTask = false), 0);
  });
  await wait(DRAW_GAP_MS + 20);

  // Records in tasks of their own, 5 ms apart (an agent writing fast), all inside one gap.
  const count = Math.floor(DRAW_GAP_MS / 10);
  for (let n = 1; n <= count; n++) {
    drawSoon(() => client.setQueryData<number[]>(key, (held = []) => [...held, n]));
    if (n === 1) expect(client.getQueryData(key)).toEqual([1]);
    await wait(5);
  }
  await wait(DRAW_GAP_MS + 50);

  expect(client.getQueryData(key)).toEqual(Array.from({ length: count }, (_, i) => i + 1));
  expect(redraws).toBe(2);
  stop();
  client.clear();
});
