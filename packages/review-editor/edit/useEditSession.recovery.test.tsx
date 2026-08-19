/**
 * Dirty-session recovery on file-set change.
 *
 * `fileSetKey` changes on more than diff switches — sort-order and
 * collapse-default flips remount the CodeView too — and Pierre tears the
 * editor down without a completion callback on remount. A dirty session must
 * never be silently discarded there: the controller recovers the last-known
 * document contents and prompts to keep them as suggestions (the same
 * pattern as the dirty file-switch prompt in startEdit).
 *
 * The pure recovery helper is tested without DOM; the full hook flow
 * (startEdit -> change -> fileSetKey change -> prompt -> suggestion sink) is
 * DOM-gated (DOM_TESTS=1) and registered in .github/workflows/test.yml's
 * "Run UI seam-contract + DOM tests" step.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeViewHandle } from '@pierre/diffs/react';
import type { CodeViewItem, FileDiffMetadata } from '@pierre/diffs';
import type { DiffAnnotationMetadata } from '@plannotator/ui/types';
import type { DiffFile } from '../types';
import { recoverDirtySessionHunks, useEditSession, type EditSessionApi } from './useEditSession';
import type { SuggestionHunk } from './deriveSuggestions';

const hasDom = typeof document !== 'undefined';

describe('recoverDirtySessionHunks', () => {
  test('derives hunks from the last observed contents', () => {
    const hunks = recoverDirtySessionHunks({
      preEditContent: 'one\ntwo\nthree\n',
      latestContents: { contents: 'one\nTWO\nthree\n' },
    });
    expect(hunks).toEqual([
      { lineStart: 2, lineEnd: 2, originalCode: 'two', suggestedCode: 'TWO' },
    ]);
  });

  test('reads contents lazily at recovery time (live getter)', () => {
    let text = 'one\n';
    const live = {
      get contents() {
        return text;
      },
    };
    const session = { preEditContent: 'one\n', latestContents: live };
    text = 'one\nnew line\n';
    const hunks = recoverDirtySessionHunks(session);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].suggestedCode).toBe('one\nnew line');
  });

  test('returns [] when nothing was captured', () => {
    expect(recoverDirtySessionHunks({ preEditContent: 'one\n', latestContents: null })).toEqual([]);
  });

  test('returns [] when the document can no longer be read', () => {
    const broken = {
      get contents(): string {
        throw new Error('document disposed');
      },
    };
    expect(
      recoverDirtySessionHunks({ preEditContent: 'one\n', latestContents: broken }),
    ).toEqual([]);
  });

  test('returns [] when the edits net out to no change', () => {
    expect(
      recoverDirtySessionHunks({
        preEditContent: 'one\ntwo\n',
        latestContents: { contents: 'one\ntwo\n' },
      }),
    ).toEqual([]);
  });
});

describe.if(hasDom)('useEditSession file-set change with a dirty session (DOM)', () => {
  const PRE_EDIT = 'line one\nline two\nline three\n';

  let host: HTMLDivElement | null = null;
  let root: Root | null = null;
  // The describe body runs (for registration) even when the suite is skipped,
  // so window may only be touched behind the hasDom guard.
  const realConfirm = hasDom ? window.confirm : undefined;

  afterEach(async () => {
    if (root) {
      await act(async () => root!.unmount());
      root = null;
    }
    host?.remove();
    host = null;
    if (hasDom && realConfirm) window.confirm = realConfirm;
  });

  interface Harness {
    api: EditSessionApi;
    item: CodeViewItem<DiffAnnotationMetadata>;
    fileSetKeyRef: { current: string };
    added: Array<{ filePath: string; hunks: SuggestionHunk[] }>;
  }

  async function mountHarness(): Promise<Harness> {
    const fileDiff = {
      name: 'src/calc.ts',
      isPartial: false,
      additionLines: PRE_EDIT.split(/(?<=\n)/),
      hunks: [],
    } as unknown as FileDiffMetadata;
    const item = {
      id: 'item-1',
      type: 'diff',
      fileDiff,
      version: 0,
    } as unknown as CodeViewItem<DiffAnnotationMetadata>;
    const handle = {
      getItem: (id: string) => (id === item.id ? item : undefined),
      updateItem: () => {},
    } as unknown as CodeViewHandle<DiffAnnotationMetadata>;
    const file: DiffFile = {
      path: 'src/calc.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      patch: '@@ -1 +1 @@\n-a\n+b\n',
    } as DiffFile;

    const added: Array<{ filePath: string; hunks: SuggestionHunk[] }> = [];
    const fileSetKeyRef = { current: 'gen-1' };
    let api: EditSessionApi | null = null;

    function HookHost() {
      const viewerRef = useRef<CodeViewHandle<DiffAnnotationMetadata> | null>(handle);
      const itemIdToFileRef = useRef(new Map([[item.id, file]]));
      const reviewBaseRef = useRef<string | undefined>(undefined);
      const reviewSnapshotIdRef = useRef<string | undefined>(undefined);
      const annotationsRef = useRef([]);
      api = useEditSession({
        enabled: true,
        viewerRef,
        itemIdToFileRef,
        fileSetKeyRef,
        reviewBaseRef,
        reviewSnapshotIdRef,
        annotationsRef,
        onAddSuggestions: (filePath, hunks) => added.push({ filePath, hunks }),
        refreshItem: () => {},
      });
      return null;
    }

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<HookHost />);
    });

    // startEdit loads the (real) editor chunk before flipping edit on.
    await act(async () => {
      api!.startEdit(item.id);
    });
    for (let i = 0; i < 20 && api!.editingItemIdRef.current !== item.id; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
    expect(api!.editingItemIdRef.current).toBe(item.id);
    return { api: api!, item, fileSetKeyRef, added };
  }

  test('dirty session prompts and keeps recovered edits as suggestions on confirm', async () => {
    const { api, item, fileSetKeyRef, added } = await mountHarness();
    const prompts: string[] = [];
    window.confirm = (message?: string) => {
      prompts.push(message ?? '');
      return true;
    };

    await act(async () => {
      api.onItemEditChange(item, { contents: 'line one\nline 2 edited\nline three\n' });
    });
    fileSetKeyRef.current = 'gen-2'; // sort-order flip, diff switch, etc.
    await act(async () => {
      api.handleFileSetChange();
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('src/calc.ts');
    expect(added).toEqual([
      {
        filePath: 'src/calc.ts',
        hunks: [
          {
            lineStart: 2,
            lineEnd: 2,
            originalCode: 'line two',
            suggestedCode: 'line 2 edited',
          },
        ],
      },
    ]);
    expect(api.editingItemIdRef.current).toBeNull();
  });

  test('dirty session discards on decline, but only after asking', async () => {
    const { api, item, fileSetKeyRef, added } = await mountHarness();
    let prompted = 0;
    window.confirm = () => {
      prompted++;
      return false;
    };

    await act(async () => {
      api.onItemEditChange(item, { contents: 'changed\n' });
    });
    fileSetKeyRef.current = 'gen-2';
    await act(async () => {
      api.handleFileSetChange();
    });

    expect(prompted).toBe(1);
    expect(added).toEqual([]);
    expect(api.editingItemIdRef.current).toBeNull();
  });

  test('clean session drops silently without prompting', async () => {
    const { api, fileSetKeyRef, added } = await mountHarness();
    let prompted = 0;
    window.confirm = () => {
      prompted++;
      return true;
    };

    fileSetKeyRef.current = 'gen-2';
    await act(async () => {
      api.handleFileSetChange();
    });

    expect(prompted).toBe(0);
    expect(added).toEqual([]);
    expect(api.editingItemIdRef.current).toBeNull();
  });

  test('dirty session whose edits net out to no change does not prompt', async () => {
    const { api, item, fileSetKeyRef, added } = await mountHarness();
    let prompted = 0;
    window.confirm = () => {
      prompted++;
      return true;
    };

    await act(async () => {
      api.onItemEditChange(item, { contents: PRE_EDIT });
    });
    fileSetKeyRef.current = 'gen-2';
    await act(async () => {
      api.handleFileSetChange();
    });

    expect(prompted).toBe(0);
    expect(added).toEqual([]);
  });
});
