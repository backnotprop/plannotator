import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentLaunchParams } from '@plannotator/ui/hooks/useAgentJobs';
import { ReviewStateProvider, type ReviewState } from '../../dock/ReviewStateContext';

mock.module('@pierre/diffs/worker/worker.js?worker&inline', () => ({ default: class {} }));
mock.module('../../hooks/guide/useGuideData', () => ({
  useCurrentGuide: () => ({
    guide: {
      id: 'persisted-guide',
      outdated: true,
      generatedAt: 1,
      engine: 'pi',
      launch: { engine: 'pi', model: 'openai/gpt-5', thinking: 'low' },
    },
    loading: false,
  }),
  useGuideData: () => ({
    guide: {
      title: 'Persisted guide',
      intent: 'Review the durable artifact.',
      sections: [{ title: 'Storage', overview: 'Persists state.', diffs: [] }],
      reviewed: [true],
    },
    loading: false,
    error: null,
    reviewed: [true],
    toggleReviewed: () => {},
    retry: () => {},
  }),
}));

const { GuideScreen } = await import('./GuideScreen');
const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.innerHTML = '';
});

describe('GuideScreen persisted guide', () => {
  test.skipIf(!hasDom)('shows Outdated and regenerates with the saved launch settings', async () => {
    const launches: AgentLaunchParams[] = [];
    const state = {
      files: [],
      rawPatch: 'changed patch',
      prMetadata: null,
      currentWorktreePath: null,
    } as unknown as ReviewState;
    host = document.createElement('div');
    document.body.appendChild(host);

    await act(async () => {
      root = createRoot(host!);
      root.render(
        <ReviewStateProvider value={state}>
          <GuideScreen
            activeGuideJobId={null}
            jobs={[]}
            capabilities={null}
            launchJob={async (params) => {
              launches.push(params);
              return null;
            }}
            killJob={async () => {}}
            onClose={() => {}}
          />
        </ReviewStateProvider>,
      );
    });

    expect(host.textContent).toContain('Outdated guide');
    expect(host.textContent).toContain('The reviewed changeset has moved since this guide was generated.');
    expect(host.textContent).toContain('Persisted guide');

    const outdatedLabel = [...host.querySelectorAll('span')]
      .find((span) => span.textContent === 'Outdated guide');
    const outdatedBanner = outdatedLabel?.parentElement?.parentElement;
    const outdatedMessage = outdatedLabel?.nextElementSibling;
    expect(outdatedBanner?.classList.contains('text-foreground')).toBe(true);
    expect(outdatedBanner?.classList.contains('text-warning-foreground')).toBe(false);
    expect(outdatedMessage?.classList.contains('text-muted-foreground')).toBe(true);

    const regenerate = [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Regenerate guide');
    expect(regenerate).not.toBeUndefined();

    await act(async () => regenerate?.click());
    expect(launches).toEqual([{
      provider: 'guide',
      label: 'Guided Review',
      engine: 'pi',
      model: 'openai/gpt-5',
      thinking: 'low',
    }]);
  });
});
