import { expect, test } from 'bun:test';
import type { ThreadModel } from './api';
import { createThreadCache } from './threadCache';

const model = (id: string, body = 'hello'): ThreadModel => ({ serverSession: 's', cursor: 1, thread: { thread_id: id, subject: body } as unknown as ThreadModel['thread'] });

test('keeps the last few threads opened, the least recently opened dropped first', () => {
  const cache = createThreadCache(2);
  cache.put('a', model('a'), cache.begin('a'));
  cache.put('b', model('b'), cache.begin('b'));
  expect(cache.get('a')).not.toBeNull();
  cache.put('c', model('c'), cache.begin('c'));
  // `a` was opened again after `b`: `b` goes.
  expect(cache.get('b')).toBeNull();
  expect(cache.get('a')).not.toBeNull();
  expect(cache.get('c')).not.toBeNull();
});

test('a copy older than the limit is not shown', () => {
  const cache = createThreadCache(8, 1000);
  cache.put('a', model('a'), cache.begin('a'), 0);
  expect(cache.get('a', 999)).not.toBeNull();
  expect(cache.get('a', 2001)).toBeNull();
});

test('a read that started before a record of its thread is never kept: it may predate the change', () => {
  const cache = createThreadCache();
  const token = cache.begin('a');
  // The stream says the thread changed while the read was out.
  cache.drop('a');
  cache.put('a', model('a', 'old'), token);
  expect(cache.get('a')).toBeNull();
  // A read begun after the record is kept.
  cache.put('a', model('a', 'new'), cache.begin('a'));
  expect(cache.get('a')?.thread.subject).toBe('new');
});

test('a drop of one thread leaves the others; a gap in the stream drops every copy, reads in flight included', () => {
  const cache = createThreadCache();
  cache.put('a', model('a'), cache.begin('a'));
  cache.put('b', model('b'), cache.begin('b'));
  const inFlight = cache.begin('c');
  cache.drop('a');
  expect(cache.get('a')).toBeNull();
  expect(cache.get('b')).not.toBeNull();
  cache.clear();
  expect(cache.get('b')).toBeNull();
  cache.put('c', model('c'), inFlight);
  expect(cache.get('c')).toBeNull();
});

test('prune keeps only the threads the list still has', () => {
  const cache = createThreadCache();
  cache.put('a', model('a'), cache.begin('a'));
  cache.put('b', model('b'), cache.begin('b'));
  cache.prune((id) => id === 'b');
  expect(cache.get('a')).toBeNull();
  expect(cache.get('b')).not.toBeNull();
});
