import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SemanticDiffChange } from '@plannotator/shared/semantic-diff-types';
import { ReviewStateProvider, type ReviewState } from '../dock/ReviewStateContext';
import type { SemanticFileState } from '../semDiff/semanticFileState';
import { SemanticFileBadge } from './SemanticFileBadge';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

const change = (entityName: string, changeType: string): SemanticDiffChange => ({
  entityId: entityName,
  changeType,
  entityType: 'function',
  entityName,
  oldEntityName: null,
  filePath: 'a.ts',
  oldFilePath: null,
  startLine: 1,
  endLine: 2,
  oldStartLine: 1,
  oldEndLine: 2,
  structuralChange: true,
});

const seven = [...['b', 'c', 'd', 'e', 'f', 'g'].map((name) => change(name, 'modified')), change('h', 'moved')];
const movedOne = { counts: { moved: 1 } } as never;

async function draw(fileState: SemanticFileState | null, changes: SemanticDiffChange[]) {
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  const state = { semanticDiffAvailable: true, semanticChanges: changes } as unknown as ReviewState;
  await act(async () => {
    root!.render(
      <ReviewStateProvider value={state}>
        <SemanticFileBadge filePath="a.ts" semantic={fileState ? { state: fileState, onToggle: () => {} } : undefined} />
      </ReviewStateProvider>,
    );
  });
  return document.querySelector<HTMLElement>('[data-semantic-file-badge]')!;
}

const popover = () => document.querySelector('[data-semantic-file-popover]');

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = '';
});

describe('SemanticFileBadge', () => {
  test.skipIf(!hasDom)("a file whose own result is still being worked out keeps the list's count and still opens", async () => {
    await draw(null, seven);
    const chip = await draw({ status: 'working' }, seven);
    expect(chip.dataset.semanticFileBadge).toBe('7');
    await act(async () => chip.click());
    expect(popover()).not.toBeNull();
  });

  test.skipIf(!hasDom)('a popover open when the chip greys out does not open again by itself when the result lands', async () => {
    const chip = await draw({ status: 'off', summary: movedOne }, []);
    await act(async () => chip.click());
    expect(popover()).not.toBeNull();
    expect((await draw({ status: 'working' }, [])).dataset.semanticFileBadge).toBe('pending');
    await draw({ status: 'off', summary: movedOne }, []);
    expect(popover()).toBeNull();
  });

  test.skipIf(!hasDom)('switched off, the title names what is not shown as the label does, and the count stays the file\'s', async () => {
    const chip = await draw({ status: 'off', summary: movedOne }, seven);
    expect(chip.textContent).toBe('sem7');
    expect([chip.title.includes('1 moved'), chip.getAttribute('aria-label')!.includes('1 moved')]).toEqual([true, true]);
  });

  test.skipIf(!hasDom)('a file with fewer listed changes than noted kinds names both, so the count on the chip is explained', async () => {
    const chip = await draw({ status: 'semantic', summary: { counts: { moved: 3 } } as never }, [change('b', 'moved')]);
    expect(chip.textContent).toBe('sem1');
    expect(chip.getAttribute('aria-label')).toContain('1 semantic change; 3 moved');
  });
});
