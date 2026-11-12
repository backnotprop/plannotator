import { describe, expect, test } from 'bun:test';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { createListReader, type ListReadAnswer } from './listRead';

type Model = { sections: { id: 'waiting'; label: string; threads: InboxListRow[] }[]; cursor: number; list_version?: string };

const row = (id: string, subject: string) => ({ thread_id: id, subject }) as InboxListRow;
const whole = (version: string, cursor: number, ...rows: InboxListRow[]): Model => ({ cursor, list_version: version, sections: [{ id: 'waiting', label: 'Waiting on you', threads: rows }] });
const change = (since: string, version: string, cursor: number, rows: InboxListRow[], order: string[]): ListReadAnswer<Model> => ({
  cursor,
  list_version: version,
  delta: { since, rows, sections: [{ id: 'waiting', label: 'Waiting on you', threads: order }], lists: {} },
});

function scripted() {
  const asked: string[] = [];
  const pending: { since: string; answer: (a: ListReadAnswer<Model>) => void; fail: (e: Error) => void }[] = [];
  const fetchList = (since: string) =>
    new Promise<ListReadAnswer<Model>>((answer, fail) => {
      asked.push(since);
      pending.push({ since, answer, fail });
    });
  return { asked, pending, fetchList };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('the list reader', () => {
  test('calls in the same tick share one read', async () => {
    const s = scripted();
    const reader = createListReader<Model>(s.fetchList);
    const burst = [reader.read(), reader.read(), reader.read()];
    await tick();
    expect(s.asked).toEqual(['']);
    s.pending[0]!.answer(whole('v1', 1, row('a', 'A')));
    const first = await Promise.all(burst);
    expect(new Set(first).size).toBe(1);
    const after = [reader.read(), reader.read()];
    await tick();
    expect(s.asked).toEqual(['', 'v1']);
    s.pending[1]!.answer(change('v1', 'v2', 2, [row('b', 'B')], ['b', 'a']));
    const second = await Promise.all(after);
    expect(new Set(second).size).toBe(1);
    expect(second[0]!.sections[0]!.threads.map((r) => r.subject)).toEqual(['B', 'A']);
  });

  test('a call while a read is out starts its own at once (a slow answer never holds a newer one back), and both land right in either order', async () => {
    const s = scripted();
    const reader = createListReader<Model>(s.fetchList);
    const one = reader.read();
    await tick();
    s.pending[0]!.answer(whole('v1', 1, row('a', 'A')));
    await one;
    const slow = reader.read();
    await tick();
    const fast = reader.read();
    await tick();
    expect(s.asked).toEqual(['', 'v1', 'v1']);
    s.pending[2]!.answer(change('v1', 'v3', 3, [row('a', 'A3'), row('c', 'C')], ['c', 'a']));
    expect((await fast).sections[0]!.threads.map((r) => r.subject)).toEqual(['C', 'A3']);
    s.pending[1]!.answer(change('v1', 'v2', 2, [row('a', 'A2')], ['a']));
    expect((await slow).sections[0]!.threads.map((r) => r.subject)).toEqual(['A2']);
    const later = reader.read();
    await tick();
    expect(s.asked.at(-1)).toBe('v3');
    s.pending[3]!.answer(change('v3', 'v4', 4, [], ['c', 'a']));
    expect((await later).sections[0]!.threads.map((r) => r.subject)).toEqual(['C', 'A3']);
  });

  test('a change from another version than the one held is never applied: the whole list is read instead', async () => {
    const s = scripted();
    const reader = createListReader<Model>(s.fetchList);
    const one = reader.read();
    await tick();
    s.pending[0]!.answer(whole('v1', 1, row('a', 'A')));
    await one;
    const two = reader.read();
    await tick();
    s.pending[1]!.answer(change('v0', 'v2', 2, [], ['a']));
    await tick();
    expect(s.asked).toEqual(['', 'v1', '']);
    s.pending[2]!.answer(whole('v3', 3, row('a', 'A again')));
    expect((await two).sections[0]!.threads[0]!.subject).toBe('A again');
  });

  test('a change naming a row neither it nor the held list has is never drawn with a hole: the whole list is read', async () => {
    const s = scripted();
    const reader = createListReader<Model>(s.fetchList);
    const one = reader.read();
    await tick();
    s.pending[0]!.answer(whole('v1', 1, row('a', 'A')));
    await one;
    const two = reader.read();
    await tick();
    s.pending[1]!.answer(change('v1', 'v2', 2, [], ['a', 'ghost']));
    await tick();
    expect(s.asked.at(-1)).toBe('');
    s.pending[2]!.answer(whole('v3', 3, row('a', 'A'), row('ghost', 'G')));
    expect((await two).sections[0]!.threads.map((r) => r.thread_id)).toEqual(['a', 'ghost']);
  });

  test('a failed read keeps the list held: the next read still asks for the changes since it', async () => {
    const s = scripted();
    const reader = createListReader<Model>(s.fetchList);
    const one = reader.read();
    await tick();
    s.pending[0]!.answer(whole('v1', 1, row('a', 'A')));
    await one;
    const failed = reader.read();
    await tick();
    s.pending[1]!.fail(new Error('offline'));
    await expect(failed).rejects.toThrow('offline');
    const again = reader.read();
    await tick();
    expect(s.asked).toEqual(['', 'v1', 'v1']);
    s.pending[2]!.answer(change('v1', 'v2', 2, [row('a', 'A2')], ['a']));
    expect((await again).sections[0]!.threads[0]!.subject).toBe('A2');
  });

  test('an Inbox that answers without a version (older) is read whole every time', async () => {
    const s = scripted();
    const reader = createListReader<Model>(s.fetchList);
    const one = reader.read();
    await tick();
    s.pending[0]!.answer({ cursor: 1, sections: [{ id: 'waiting', label: 'Waiting on you', threads: [row('a', 'A')] }] });
    await one;
    const two = reader.read();
    await tick();
    expect(s.asked).toEqual(['', '']);
    s.pending[1]!.answer({ cursor: 2, sections: [] } as unknown as Model);
    await two;
  });
});
