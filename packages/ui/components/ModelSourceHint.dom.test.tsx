import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AIProviderOption } from '../utils/aiProvider';

const hasDom = typeof document !== 'undefined';
const barModule = hasDom ? await import('./ai/AIProviderBar') : null;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const models = [
  { id: 'gpt-6-sol', label: 'GPT-6-Sol', default: true },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
];

async function renderBar(provider: AIProviderOption): Promise<HTMLElement | null> {
  const { AIProviderBar } = barModule!;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <AIProviderBar
        providers={[provider]}
        selectedProviderId={provider.id}
        selectedModel={null}
        onProviderChange={() => {}}
        onModelChange={() => {}}
      />,
    ),
  );
  return host.querySelector<HTMLElement>('[data-model-source-hint]');
}

describe.if(hasDom)('model source hint under the Ask AI model picker', () => {
  test('a discovered list names the installed tool version', async () => {
    const hint = await renderBar({ id: 'codex-sdk', name: 'codex-sdk', models, modelsSource: 'discovered', toolVersion: '0.155.1' });
    expect(hint?.dataset.modelSourceHint).toBe('discovered');
    expect(hint?.textContent).toContain('Codex 0.155.1');
  });

  test('a fallback list says so instead of claiming the installed tool', async () => {
    const hint = await renderBar({ id: 'claude-agent-sdk', name: 'claude-agent-sdk', models, modelsSource: 'fallback', toolVersion: '2.1.282' });
    expect(hint?.dataset.modelSourceHint).toBe('fallback');
    expect(hint?.textContent).toContain('Claude Code');
    expect(hint?.textContent).not.toContain('2.1.282');
  });

  test('no hint when the server sends no tool version, or for other providers', async () => {
    expect(await renderBar({ id: 'codex-sdk', name: 'codex-sdk', models, modelsSource: 'discovered' })).toBeNull();
    act(() => root?.unmount());
    expect(await renderBar({ id: 'pi-sdk', name: 'pi-sdk', models, modelsSource: 'discovered', toolVersion: '1.0.0' })).toBeNull();
  });
});
