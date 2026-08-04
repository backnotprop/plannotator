/**
 * DOM-gated tests (DOM_TESTS=1) for the experimental edit-to-suggestion
 * affordance in FileHeader. Registered in .github/workflows/test.yml's
 * "Run UI seam-contract + DOM tests" step.
 *
 * Flag-off invariant: when the feature is off, AllFilesCodeView passes no
 * onEditFile, so FileHeader must render ZERO edit UI (byte-identical header).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileHeader } from './FileHeader';
// Relative import: the ui package exposes './config' (no ./config/settings
// subpath), and the registry itself is not re-exported from the barrel.
import { SETTINGS } from '../../ui/config/settings';

const hasDom = typeof document !== 'undefined';

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(node: React.ReactElement): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
  return host;
}

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  host?.remove();
  host = null;
});

describe('edit-to-suggestion flag', () => {
  test('the editSuggestions setting defaults OFF', () => {
    expect(SETTINGS.editSuggestions.defaultValue).toBe(false);
    // Cookie-only while experimental: never synced to server config.
    expect(SETTINGS.editSuggestions.serverKey).toBeUndefined();
  });
});

describe.if(hasDom)('FileHeader edit affordance (DOM)', () => {
  const baseProps = { filePath: 'src/calc.ts', patch: '@@ -1 +1 @@\n-a\n+b\n' };

  test('renders no edit UI when the feature is off (no onEditFile)', async () => {
    const el = await mount(<FileHeader {...baseProps} />);
    expect(el.querySelector('[data-testid="edit-session-start"]')).toBeNull();
    expect(el.querySelector('[data-testid="edit-session-badge"]')).toBeNull();
    expect(el.querySelector('[data-testid="edit-session-complete"]')).toBeNull();
    expect(el.querySelector('[data-testid="edit-session-cancel"]')).toBeNull();
  });

  test('renders the Edit entry button when enabled and idle', async () => {
    let started = 0;
    const el = await mount(<FileHeader {...baseProps} onEditFile={() => started++} />);
    const btn = el.querySelector<HTMLButtonElement>('[data-testid="edit-session-start"]');
    expect(btn).not.toBeNull();
    await act(async () => btn!.click());
    expect(started).toBe(1);
    expect(el.querySelector('[data-testid="edit-session-badge"]')).toBeNull();
  });

  test('disabled reason blocks entry and surfaces as tooltip', async () => {
    let started = 0;
    const el = await mount(
      <FileHeader
        {...baseProps}
        onEditFile={() => started++}
        editDisabledReason="Full file content unavailable"
      />,
    );
    const btn = el.querySelector<HTMLButtonElement>('[data-testid="edit-session-start"]');
    expect(btn).not.toBeNull();
    expect(btn!.disabled).toBe(true);
    expect(btn!.title).toBe('Full file content unavailable');
    await act(async () => btn!.click());
    expect(started).toBe(0);
  });

  test('editing state swaps to Suggest/Discard session controls', async () => {
    let completed = 0;
    let cancelled = 0;
    const el = await mount(
      <FileHeader
        {...baseProps}
        onEditFile={() => {}}
        isEditing
        onCompleteEdit={() => completed++}
        onCancelEdit={() => cancelled++}
      />,
    );
    expect(el.querySelector('[data-testid="edit-session-start"]')).toBeNull();
    expect(el.querySelector('[data-testid="edit-session-badge"]')).not.toBeNull();
    const complete = el.querySelector<HTMLButtonElement>('[data-testid="edit-session-complete"]');
    const cancel = el.querySelector<HTMLButtonElement>('[data-testid="edit-session-cancel"]');
    expect(complete).not.toBeNull();
    expect(cancel).not.toBeNull();
    await act(async () => complete!.click());
    await act(async () => cancel!.click());
    expect(completed).toBe(1);
    expect(cancelled).toBe(1);
  });
});
