import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AIProviderOption } from '../../utils/aiProvider';

const hasDom = typeof document !== 'undefined';
const barModule = hasDom ? await import('./AIProviderBar') : null;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const providerWithEffort: AIProviderOption = {
  id: 'codex-sdk',
  name: 'codex-sdk',
  models: [
    {
      id: 'gpt-6-sol',
      label: 'GPT-6-Sol',
      default: true,
      reasoningEfforts: [
        { id: 'low', label: 'Low' },
        { id: 'high', label: 'High' },
      ],
    },
  ],
};

describe.if(hasDom)('AIProviderBar select styling', () => {
  test('all select dropdowns style options to match container theme background', async () => {
    const { AIProviderBar } = barModule!;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        <AIProviderBar
          providers={[providerWithEffort]}
          selectedProviderId={providerWithEffort.id}
          selectedModel="gpt-6-sol"
          selectedReasoningEffort="low"
          onProviderChange={() => {}}
          onModelChange={() => {}}
          onReasoningEffortChange={() => {}}
        />,
      ),
    );

    const selects = host.querySelectorAll<HTMLSelectElement>('select');
    expect(selects.length).toBe(3); // provider, model, reasoning effort

    for (const select of selects) {
      expect(select.className).toContain('[&>option]:bg-card');
      expect(select.className).toContain('[&>option]:text-foreground');
    }
  });
});
