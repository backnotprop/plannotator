/**
 * Full screen with the tools hidden (DOM_TESTS=1): a comment not sent waits in the file, so the corner control (the
 * handle's ⌃⌃) carries a dot on its arrows, and its name says so (approval "inbox-comment-box", visible drafts).
 *
 * Failures to catch: the words left in a hidden comment have no sign at all; the dot shows with nothing waiting; a
 * screen reader hears nothing about it, or hears the dot itself instead of the handle's name.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FullViewBarHandle } from './components/FullViewBar';

const hasDom = typeof document !== 'undefined';
const { FullViewBar } = (hasDom ? await import('./components/FullViewBar') : {}) as typeof import('./components/FullViewBar');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function mountBar(opts: { commentDraft?: boolean; draft?: boolean; handleCount?: number }): Promise<HTMLButtonElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <FullViewBar
        ref={createRef<FullViewBarHandle>()}
        phone={false}
        state="tucked"
        onState={() => {}}
        announce={() => {}}
        armed={false}
        comments={null}
        handleCount={opts.handleCount ?? 0}
        changed={false}
        draft={opts.draft}
        commentDraft={opts.commentDraft}
        position={null}
        more={null}
        moreOpen={false}
        leave={{ kind: 'exit', onLeave: () => {} }}
        chord={null}
      />,
    );
  });
  const handle = host.querySelector<HTMLButtonElement>('[data-full-view-handle]');
  if (!handle) throw new Error('no corner control');
  return handle;
}

describe.if(hasDom)('the corner control with a comment not sent', () => {
  test('a dot on the arrows, hidden from readers; the name says "comment not sent"', async () => {
    const handle = await mountBar({ commentDraft: true, handleCount: 2 });
    const dot = handle.querySelector<HTMLElement>('[data-full-view-comment-dot]');
    expect(dot).not.toBeNull();
    expect(dot!.getAttribute('aria-hidden')).toBe('true');
    // On the arrows: inside the box that holds the ⌃⌃ icon.
    expect(dot!.parentElement!.querySelector('svg')).not.toBeNull();
    expect(handle.getAttribute('aria-label')).toBe('Show tools, comment not sent, 2 comments');
  });

  test('nothing waiting: no dot, and the name is the plain one', async () => {
    const handle = await mountBar({ commentDraft: false, draft: true });
    expect(handle.querySelector('[data-full-view-comment-dot]')).toBeNull();
    expect(handle.getAttribute('aria-label')).toBe('Show tools, reply draft');
  });
});
