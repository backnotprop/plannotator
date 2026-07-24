import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeGuideData } from '@plannotator/shared/guide';
import { ReviewStateProvider, type ReviewState } from '../../dock/ReviewStateContext';

// DiffViewer (imported via GuideDiffSection) loads its diff worker through a
// Vite `?worker&inline` virtual module that bun's test resolver can't parse;
// stub it before the component graph loads (hence the dynamic import below).
mock.module('@pierre/diffs/worker/worker.js?worker&inline', () => ({ default: class {} }));
const { GuideView } = await import('./GuideView');

const hasDom = typeof document !== 'undefined';

function makeGuide(overrides: Partial<CodeGuideData> = {}): CodeGuideData {
  return {
    title: 'Persisted guide',
    intent: 'Test intent.',
    sections: [{ title: 'Core', overview: 'The heart.', diffs: [{ file: 'a.ts' }] }],
    reviewed: [false],
    ...overrides,
  };
}

function makeState(): ReviewState {
  return {
    files: [],
    guideRevealFile: null,
  } as unknown as ReviewState;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root !== null) {
    await act(async () => root?.unmount());
    root = null;
  }
  host?.remove();
  host = null;
  if (hasDom) document.body.innerHTML = '';
});

async function renderView(guide: CodeGuideData, onRegenerate?: () => void) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <ReviewStateProvider value={makeState()}>
        <GuideView
          guide={guide}
          reviewed={guide.reviewed}
          onToggleReviewed={() => {}}
          focusedFile={null}
          onFocusFile={() => {}}
          onRegenerate={onRegenerate}
        />
      </ReviewStateProvider>,
    );
  });
}

describe('GuideView persistence affordances (#1112)', () => {
  test.skipIf(!hasDom)('renders no Saved chip and no outdated hint by default', async () => {
    await renderView(makeGuide());
    expect(host!.textContent).not.toContain('Saved');
    expect(host!.textContent).not.toContain('Generated on a different version');
  });

  test.skipIf(!hasDom)('renders the Saved chip when the guide is persisted', async () => {
    await renderView(makeGuide({ saved: true }));
    expect(host!.textContent).toContain('Saved');
    expect(host!.textContent).not.toContain('Generated on a different version');
  });

  test.skipIf(!hasDom)('renders the outdated hint with a wired Regenerate action when moved', async () => {
    let regenerated = 0;
    await renderView(makeGuide({ saved: true, moved: true }), () => {
      regenerated += 1;
    });
    expect(host!.textContent).toContain('Generated on a different version of this branch');

    const regenerate = [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Regenerate');
    expect(regenerate).not.toBeNull();
    await act(async () => {
      regenerate!.click();
    });
    expect(regenerated).toBe(1);
  });

  test.skipIf(!hasDom)('moved without a regenerate handler renders the hint without a button', async () => {
    await renderView(makeGuide({ saved: true, moved: true }));
    expect(host!.textContent).toContain('Generated on a different version of this branch');
    expect([...host!.querySelectorAll('button')].find((b) => b.textContent === 'Regenerate')).toBeUndefined();
  });
});
