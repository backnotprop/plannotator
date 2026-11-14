import { expect, test } from 'bun:test';
import { createRecordPause } from './recordPause';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('records close together share one read; a look takes the read waiting, or the next one, at once', async () => {
  let reads = 0;
  const pause = createRecordPause(async () => ++reads, 40);
  pause.ask(false);
  pause.ask(false);
  await tick(60);
  expect(reads).toBe(1);

  pause.ask(false);
  expect(await pause.afterLook(200)).toBe(2);
  await tick(60);
  expect(reads).toBe(2);

  const look = pause.afterLook(200);
  await tick(5);
  pause.ask(false);
  expect(await look).toBe(3);
  await tick(60);
  expect(reads).toBe(3);
  pause.stop();
});

test('no record within the wait: the look hears none and reads the list itself', async () => {
  let reads = 0;
  const pause = createRecordPause(async () => ++reads, 40);
  expect(await pause.afterLook(30)).toBeUndefined();
  expect(reads).toBe(0);
  pause.stop();
});
