/**
 * The pause before the records' read, and a look joining it (recordPause.ts). Failures to catch: a look reading the
 * list on its own while its record's read comes anyway (two reads per look in every window), and a look that waits
 * for good when no record comes (the stream down).
 */
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

  // A record waits its pause: the look starts it now, and it is the only read.
  pause.ask(false);
  expect(await pause.afterLook(200)).toBe(2);
  await tick(60);
  expect(reads).toBe(2);

  // The look first: the next record's read starts at once and is the look's.
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
