/**
 * Jumping to an annotation in another document (DOM-gated).
 *
 * Failures to catch:
 *  - Selecting the target id before the destination commits: the selection
 *    lands on the document the reviewer is leaving (where that id does not
 *    exist), so the click appears to do nothing.
 *  - Not navigating at all, or navigating to the wrong path.
 *  - A navigation that never commits leaving a selection armed, which would
 *    then fire into whatever document happens to be open later.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useAnnotationJump } from './useAnnotationJump';

const hasDom = typeof document !== 'undefined';

const OPEN = '/repo/open.md';
const TARGET = '/repo/target.md';

interface Api {
  jump: (path: string, id: string) => void;
  setCurrentPath: (path: string | null) => void;
}

let api: Api | null = null;
let navigate = mock((_path: string) => {});
let select = mock((_id: string) => {});

const Harness: React.FC<{ commitTimeoutMs?: number }> = ({ commitTimeoutMs }) => {
  const [currentPath, setCurrentPath] = useState<string | null>(OPEN);
  const jump = useAnnotationJump({
    currentPath,
    navigate: (path) => navigate(path),
    select: (id) => select(id),
    selectAfterCommitMs: 0,
    commitTimeoutMs,
  });
  api = { jump, setCurrentPath };
  return null;
};

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(commitTimeoutMs?: number): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<Harness commitTimeoutMs={commitTimeoutMs} />);
  });
}

async function tick(ms = 5): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

afterEach(async () => {
  if (root) {
    await act(async () => { root!.unmount(); });
    root = null;
  }
  host?.remove();
  host = null;
  api = null;
  navigate = mock((_path: string) => {});
  select = mock((_id: string) => {});
  if (hasDom) document.body.replaceChildren();
});

describe.if(hasDom)('useAnnotationJump', () => {
  test('selects in place when the annotation is in the open document', async () => {
    await mount();
    await act(async () => api!.jump(OPEN, 'ann-1'));

    expect(select.mock.calls).toEqual([['ann-1']]);
    expect(navigate).not.toHaveBeenCalled();
  });

  test('navigates first, then selects once the destination commits', async () => {
    await mount();
    await act(async () => api!.jump(TARGET, 'ann-2'));

    expect(navigate.mock.calls).toEqual([[TARGET]]);
    // Nothing selected yet — the old document is still the open one.
    await tick();
    expect(select).not.toHaveBeenCalled();

    await act(async () => api!.setCurrentPath(TARGET));
    await tick();
    expect(select.mock.calls).toEqual([['ann-2']]);
  });

  test('a commit for a different document does not settle the request', async () => {
    await mount();
    await act(async () => api!.jump(TARGET, 'ann-3'));
    await act(async () => api!.setCurrentPath('/repo/elsewhere.md'));
    await tick();
    expect(select).not.toHaveBeenCalled();

    await act(async () => api!.setCurrentPath(TARGET));
    await tick();
    expect(select.mock.calls).toEqual([['ann-3']]);
  });

  test('path spellings are compared normalized, not byte-for-byte', async () => {
    // The panel addresses documents by their NORMALIZED path (that is what
    // groupAnnotationsByDocument emits) while the host carries the raw server
    // spelling. On Windows those differ, so a jump inside the open document
    // used to navigate to a path the host already had open, and a commit for
    // the destination never matched the pending request: the click did
    // nothing at all.
    await mount();
    await act(async () => api!.setCurrentPath('C:\\repo\\open.md'));
    await act(async () => api!.jump('C:/repo/open.md', 'ann-win'));

    expect(select.mock.calls).toEqual([['ann-win']]);
    expect(navigate).not.toHaveBeenCalled();
  });

  test('a normalized destination is settled by its raw-spelling commit', async () => {
    await mount();
    await act(async () => api!.jump('C:/repo/target.md', 'ann-win-2'));
    expect(navigate.mock.calls).toEqual([['C:/repo/target.md']]);

    await act(async () => api!.setCurrentPath('C:\\repo\\target.md'));
    await tick();
    expect(select.mock.calls).toEqual([['ann-win-2']]);
  });

  test('a navigation that never commits leaves no selection armed', async () => {
    await mount(10);
    await act(async () => api!.jump(TARGET, 'ann-4'));
    await tick(30);

    // The destination arrives only after the request expired.
    await act(async () => api!.setCurrentPath(TARGET));
    await tick();
    expect(select).not.toHaveBeenCalled();
  });
});
