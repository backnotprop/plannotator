import { describe, expect, test } from 'bun:test';
import { referencedCommentQueue, type ReferencedCommentSteps } from './referencedComments';

/** Steps whose answers the test settles by hand. */
function steps(overrides: Partial<ReferencedCommentSteps> = {}) {
  const log: string[] = [];
  const failures: { cause: unknown; unsaved: object[] }[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let saves = 0;
  const base: ReferencedCommentSteps = {
    attach: async () => {
      log.push('attach');
      await gate;
      return 'att_1';
    },
    save: async (id, annotation) => {
      log.push(`save ${id} ${(annotation as { text: string }).text}`);
      return `rec_${++saves}`;
    },
    done: (id, first) => void log.push(`done ${id} ${first}`),
    failed: (cause, unsaved) => void failures.push({ cause, unsaved }),
  };
  return { log, failures, release, steps: { ...base, ...overrides } };
}

describe('comments on a file a message names, before it is attached', () => {
  test('a second comment made while the first attaches waits its turn: both are kept, in order, and the file is attached once', async () => {
    const t = steps();
    const queue = referencedCommentQueue(t.steps);
    const one = queue.add({ text: 'first' });
    const two = queue.add({ text: 'second' });
    t.release();
    expect(await Promise.all([one, two])).toEqual([true, true]);
    expect(t.log).toEqual(['attach', 'save att_1 first', 'save att_1 second', 'done att_1 rec_1']);
  });

  test("a failed save keeps the comment's words, and Try again keeps it without attaching again", async () => {
    let fail = true;
    const t = steps({
      attach: async () => 'att_1',
      save: async (_id, annotation) => {
        if (fail) throw new Error('session changed');
        return `rec_${(annotation as { text: string }).text}`;
      },
    });
    const queue = referencedCommentQueue(t.steps);
    expect(await queue.add({ text: 'Why 409?' })).toBe(false);
    expect(t.failures).toEqual([{ cause: new Error('session changed'), unsaved: [{ text: 'Why 409?' }] }]);
    fail = false;
    let attaches = 0;
    t.steps.attach = async () => `att_${++attaches}`;
    expect(await queue.retry()).toBe(true);
    expect(attaches).toBe(0);
  });

  test('a failed attach keeps every comment, and nothing is saved', async () => {
    const saved: string[] = [];
    const t = steps({
      attach: async () => {
        throw new Error('gone');
      },
      save: async (_id, annotation) => {
        saved.push((annotation as { text: string }).text);
        return 'rec';
      },
    });
    const queue = referencedCommentQueue(t.steps);
    expect(await queue.add({ text: 'a' })).toBe(false);
    expect(t.failures.at(-1)!.unsaved).toEqual([{ text: 'a' }]);
    expect(saved).toEqual([]);
  });
});
