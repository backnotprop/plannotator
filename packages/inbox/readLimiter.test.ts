import { describe, expect, test } from 'bun:test';
import { oneAtATime } from './readLimiter';

/** A read the test answers by hand. */
function reads() {
  const started: { resolve: (value: number) => void; reject: (cause: Error) => void }[] = [];
  const read = () =>
    new Promise<number>((resolve, reject) => {
      started.push({ resolve, reject });
    });
  return { started, read };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('oneAtATime', () => {
  test('eight asks while one read is out make one more read, not eight', async () => {
    const { started, read } = reads();
    const limited = oneAtATime(read);
    const first = limited();
    const rest = Array.from({ length: 8 }, () => limited());
    expect(started).toHaveLength(1);

    started[0]!.resolve(1);
    expect(await first).toBe(1);
    await settled();
    expect(started).toHaveLength(2);

    started[1]!.resolve(2);
    expect(await Promise.all(rest)).toEqual(Array(8).fill(2));
    await settled();
    expect(started).toHaveLength(2);
  });

  test('whoever asked during a read gets a read that began after they asked', async () => {
    const { started, read } = reads();
    const limited = oneAtATime(read);
    void limited();
    const after = limited();
    started[0]!.resolve(1);
    await settled();
    started[1]!.resolve(2);
    expect(await after).toBe(2);
  });

  test('a failed read fails its own caller, and the queued read still runs', async () => {
    const { started, read } = reads();
    const limited = oneAtATime(read);
    const first = limited();
    const queued = limited();
    started[0]!.reject(new Error('no answer'));
    await expect(first).rejects.toThrow('no answer');
    await settled();
    started[1]!.resolve(2);
    expect(await queued).toBe(2);
  });

  test('a read asked for at the moment the last one ends does not run beside the queued one', async () => {
    const { started, read } = reads();
    const limited = oneAtATime(read);
    const first = limited();
    void limited();
    started[0]!.resolve(1);
    await first;
    void limited();
    await settled();
    expect(started).toHaveLength(2);
    started[1]!.resolve(2);
    await settled();
    expect(started).toHaveLength(3);
  });

  test('with nothing out, the next ask reads at once', async () => {
    const { started, read } = reads();
    const limited = oneAtATime(read);
    const first = limited();
    started[0]!.resolve(1);
    await first;
    await settled();
    void limited();
    expect(started).toHaveLength(2);
  });
});
