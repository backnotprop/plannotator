import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { GuideSection } from '@plannotator/shared/guide';
import { ReviewStateProvider, type ReviewState } from '../../dock/ReviewStateContext';

// DiffViewer (imported via GuideDiffSection) loads its diff worker through a
// Vite `?worker&inline` virtual module that bun's test resolver can't parse;
// stub it before the component graph loads (hence the dynamic import below).
mock.module('@pierre/diffs/worker/worker.js?worker&inline', () => ({ default: class {} }));
const { GuideSectionCard } = await import('./GuideSectionCard');

const hasDom = typeof document !== 'undefined';

const section: GuideSection = {
  title: 'Payment localization module',
  overview: '',
  diffs: [{ file: 'src/payments/localize.ts' }],
};

// Minimal slice of ReviewState the card (and its GuideDiffSection children,
// which render the missing-file placeholder because `files` is empty) touches.
function makeState(overrides: Partial<ReviewState>): ReviewState {
  return {
    files: [],
    guideRevealFile: null,
    ...overrides,
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

function renderCard(state: ReviewState, props: Partial<React.ComponentProps<typeof GuideSectionCard>> = {}) {
  const element = (
    <ReviewStateProvider value={state}>
      <GuideSectionCard
        section={section}
        index={0}
        total={1}
        reviewed={false}
        onToggleReviewed={() => {}}
        focusedFile={null}
        onFocusFile={() => {}}
        {...props}
      />
    </ReviewStateProvider>
  );
  return element;
}

describe('GuideSectionCard', () => {
  test.skipIf(!hasDom)('file chip click routes through the reveal channel', async () => {
    const revealed: string[] = [];
    const state = makeState({
      onGuideRevealFile: (filePath: string) => revealed.push(filePath),
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(renderCard(state));
    });

    const chip = host.querySelector<HTMLButtonElement>('button[title="src/payments/localize.ts"]');
    expect(chip).not.toBeNull();
    await act(async () => {
      chip!.click();
    });

    // The chip must NOT scroll directly — only the reveal channel can expand
    // a collapsed (viewed) target diff before the scroll happens.
    expect(revealed).toEqual(['src/payments/localize.ts']);
  });

  test.skipIf(!hasDom)('a reveal targeting a file in a collapsed section expands and focuses it', async () => {
    const focused: string[] = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      root = createRoot(host!);
      root.render(renderCard(makeState({}), { reviewed: true, onFocusFile: (p) => focused.push(p) }));
    });

    // Collapsed row only: no file chips mounted.
    expect(host.querySelector('button[title="src/payments/localize.ts"]')).toBeNull();

    await act(async () => {
      root!.render(
        renderCard(makeState({ guideRevealFile: { path: 'src/payments/localize.ts', token: 1 } }), {
          reviewed: true,
          onFocusFile: (p) => focused.push(p),
        }),
      );
    });

    expect(host.querySelector('button[title="src/payments/localize.ts"]')).not.toBeNull();
    expect(focused).toEqual(['src/payments/localize.ts']);
  });
});
