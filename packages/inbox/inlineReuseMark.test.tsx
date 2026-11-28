import { expect, test } from 'bun:test';
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';
import { InlineReuseLayer, ReuseContext, type ReuseApi } from './reuse';

const hasDom = typeof document !== 'undefined';

test.skipIf(!hasDom)('a picture marked as captured after its message drew gets its Add to reply button with no redraw', async () => {
  const file = { id: 'att_1', name: 'shot.png', kind: 'image', size: 10, sent_sha256: 'a', current: null } as unknown as InboxAttachmentState;
  const reuse: ReuseApi = { target: 'reply', isAdded: () => false, toggle: () => {}, fileOf: (id) => (id === file.id ? file : undefined) };
  function Body() {
    const bodyRef = useRef<HTMLDivElement>(null);
    return (
      <div ref={bodyRef}>
        <img src="shot.png" alt="" />
        <InlineReuseLayer bodyRef={bodyRef} />
      </div>
    );
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<ReuseContext.Provider value={reuse}><Body /></ReuseContext.Provider>));
  const img = host.querySelector('img')!;
  img.getBoundingClientRect = () => ({ top: 0, left: 0, right: 120, bottom: 120, width: 120, height: 120, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  expect(host.querySelector('[data-reuse-surface="inline"]')).toBeNull();

  await act(async () => {
    img.setAttribute('data-inline-image', file.id);
    await new Promise((done) => setTimeout(done, 0));
  });

  expect(host.querySelector('[data-reuse-surface="inline"]')?.getAttribute('data-reuse')).toBe(file.id);
  await act(async () => root.unmount());
  host.remove();
});
