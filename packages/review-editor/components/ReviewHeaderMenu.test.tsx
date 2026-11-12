import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ThemeProvider } from '@plannotator/ui/components/ThemeProvider';
import { ReviewHeaderMenu } from './ReviewHeaderMenu';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function renderMenu(compactTouchLayout: boolean) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(
    <ThemeProvider defaultTheme="dark">
      <ReviewHeaderMenu
        onOpenSettings={() => {}}
        onOpenExport={() => {}}
        onCopyAgentInstructions={() => {}}
        onToggleFileTree={() => {}}
        onToggleSidebar={() => {}}
        isFileTreeOpen={false}
        isSidebarOpen={false}
        compactTouchLayout={compactTouchLayout}
        agentInstructionsEnabled={false}
        appVersion="test"
      />
    </ThemeProvider>,
  ));
  return host.querySelector<HTMLButtonElement>('button[aria-label="Options"]');
}

describe('ReviewHeaderMenu Options button', () => {
  test.skipIf(!hasDom)('desktop: the ☰ alone, named "Options" with no visible word', async () => {
    const trigger = await renderMenu(false);
    expect(trigger).not.toBeNull();
    expect(trigger!.getAttribute('title')).toBe('Options');
    expect(trigger!.textContent?.trim()).toBe('');
    expect(trigger!.querySelector('svg')).not.toBeNull();
  });

  test.skipIf(!hasDom)('compact touch keeps its word', async () => {
    const trigger = await renderMenu(true);
    expect(trigger!.textContent).toContain('Options');
  });
});
