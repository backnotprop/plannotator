import { expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { putThread, staleThread, staleThreads, useHeldThread } from './thread';

const hasDom = typeof document !== 'undefined';
const read = (id: string) =>
  ({
    serverSession: 's',
    cursor: 10,
    thread: { thread_id: id, project: { id: 'prj', name: 'billing', root: '/r' }, subject: id, thread_name: null, resolved_at: null, archive_seq: null, messages: [] },
  }) as never;

function setup() {
  const client = new QueryClient();
  putThread(client, 'A', read('A'));
  putThread(client, 'B', read('B'));
  const drawn: Array<string | null> = [];
  let open: (id: string) => void = () => {};
  function Pane() {
    const [threadId, setThreadId] = useState('A');
    open = setThreadId;
    const held = useHeldThread(threadId);
    drawn.push(held ? held.thread.thread_id : null);
    return null;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  act(() => root.render(<QueryClientProvider client={client}><Pane /></QueryClientProvider>));
  return { client, drawn, open: (id: string) => act(() => open(id)), done: () => act(() => root.unmount()) };
}

test.skipIf(!hasDom)('going back to a thread whose held copy went stale never draws that copy', () => {
  const pane = setup();
  staleThread(pane.client, 'B');
  pane.drawn.length = 0;
  pane.open('B');
  expect(pane.drawn).not.toContain('B');
  pane.done();
});

test.skipIf(!hasDom)('a current copy still draws at once, and a copy that goes stale while open stays drawn', () => {
  const pane = setup();
  pane.drawn.length = 0;
  pane.open('B');
  expect(pane.drawn[0]).toBe('B');
  act(() => staleThreads(pane.client));
  act(() => putThread(pane.client, 'B', read('B')));
  expect(pane.drawn.at(-1)).toBe('B');
  pane.done();
});
