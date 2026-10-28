import { expect, test } from 'bun:test';
import { runCommand } from './run-command';

test('collects output and the exit code', async () => {
  const r = await runCommand(['sh', '-c', 'echo out; echo err >&2; exit 3'], { timeoutMs: 5000 });
  expect(r).toEqual({ code: 3, out: 'out\n', err: 'err\n', timedOut: false });
});

test('kills a command past its time limit, grandchildren holding the pipes included', async () => {
  const started = Date.now();
  // The shell's background sleep keeps stdout open after the shell itself is killed.
  const r = await runCommand(['sh', '-c', 'sleep 30 & sleep 30'], { timeoutMs: 200 });
  expect(r.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(5000);
});
