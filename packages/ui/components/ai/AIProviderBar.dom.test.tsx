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

describe.if(hasDom)('AIProviderBar with "Ask this session"', () => {
  // A server with a session bridge offers only the bridge: there is nothing to
  // choose, so no picker may suggest otherwise (and none can write a cookie).
  test('renders the bridge label and no provider, model or effort picker', async () => {
    const { AIProviderBar } = barModule!;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const bridge: AIProviderOption = {
      id: 'session-bridge',
      name: 'session-bridge',
      label: 'Ask this session · Claude Code',
      models: [],
      sessionBridge: { host: 'claude-code', status: 'ready', modes: { turn: true, transient: false } },
    };
    await act(async () =>
      root!.render(
        <AIProviderBar
          providers={[bridge]}
          selectedProviderId="codex-sdk"
          selectedModel="gpt-6-sol"
          onProviderChange={() => {}}
          onModelChange={() => {}}
          onReasoningEffortChange={() => {}}
        />,
      ),
    );

    expect(host.querySelectorAll('select').length).toBe(0);
    expect(host.querySelector('[data-ai-provider-session-bridge]')?.textContent).toContain('Ask this session · Claude Code');
  });
});

describe.if(hasDom)('AIProviderBar setup hint (#1814)', () => {
  const render = async (providers: AIProviderOption[], setupHint?: string | null) => {
    const { AIProviderBar } = barModule!;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        <AIProviderBar
          providers={providers}
          selectedProviderId={null}
          selectedModel={null}
          onProviderChange={() => {}}
          onModelChange={() => {}}
          setupHint={setupHint}
        />,
      ),
    );
    return host.querySelector('[data-ai-ask-session-setup-hint]');
  };

  // Sentinel text: what matters is that the line appears in both states and is
  // absent without a hint, not its wording (askSessionSetupHint owns that).
  test('renders under the provider picker and under the empty state', async () => {
    expect((await render([providerWithEffort], 'HINT-SENTINEL'))?.textContent).toBe('HINT-SENTINEL');
    act(() => root?.unmount());
    host?.remove();
    expect((await render([], 'HINT-SENTINEL'))?.textContent).toBe('HINT-SENTINEL');
  });

  test('renders nothing extra without a hint', async () => {
    expect(await render([providerWithEffort])).toBeNull();
  });
});
