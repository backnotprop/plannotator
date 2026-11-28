import { describe, expect, it } from 'bun:test';
import { changeStepQueue, type ChangeStep } from './explorerChangeNavigation';

/** A step that runs until the test lets it finish (a cross-file landing). */
function heldSteps() {
  const started: ChangeStep[] = [];
  const finish: Array<(error?: unknown) => void> = [];
  const run = (direction: ChangeStep) => new Promise<void>((resolve, reject) => {
    started.push(direction);
    finish.push((error) => (error ? reject(error) : resolve()));
  });
  return { started, finish, run };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('changeStepQueue', () => {
  it('starts a press only after the one before it has landed, in order', async () => {
    const steps = heldSteps();
    const press = changeStepQueue(steps.run, () => {});
    press(1);
    press(1);
    press(-1);
    await settle();
    expect(steps.started).toEqual([1]);
    steps.finish[0]!();
    await settle();
    expect(steps.started).toEqual([1, 1]);
    steps.finish[1]!();
    await settle();
    expect(steps.started).toEqual([1, 1, -1]);
  });

  it('drops a held key\'s repeats while a press is under way, so letting go stops the view', async () => {
    const steps = heldSteps();
    const press = changeStepQueue(steps.run, () => {});
    press(1);
    for (let i = 0; i < 20; i += 1) press(1, true);
    await settle();
    steps.finish[0]!();
    await settle();
    expect(steps.started).toEqual([1]);
    // Nothing under way: the next repeat steps on.
    press(1, true);
    await settle();
    expect(steps.started).toEqual([1, 1]);
  });

  it('reports a failed press and still runs the next one', async () => {
    const steps = heldSteps();
    const errors: unknown[] = [];
    const press = changeStepQueue(steps.run, (error) => errors.push(error));
    press(1);
    press(1);
    await settle();
    steps.finish[0]!(new Error('boom'));
    await settle();
    expect(errors.map(String)).toEqual(['Error: boom']);
    expect(steps.started).toEqual([1, 1]);
    steps.finish[1]!();
    await settle();
    // And the queue is idle again: a repeat is not dropped.
    press(1, true);
    await settle();
    expect(steps.started).toEqual([1, 1, 1]);
  });
});
