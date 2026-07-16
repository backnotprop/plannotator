import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ActionMenu } from './ActionMenu';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

async function renderMenu(panelWidth?: 'default' | 'wide'): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ActionMenu
        panelWidth={panelWidth}
        renderTrigger={({ toggleMenu }) => <button onClick={toggleMenu}>Open</button>}
      >
        {() => <div>Panel</div>}
      </ActionMenu>,
    );
  });
  const trigger = host.querySelector('button');
  if (!trigger) throw new Error('ActionMenu trigger did not render');
  await act(async () => trigger.click());
  const panel = Array.from(host.querySelectorAll('div')).find(element =>
    element.textContent === 'Panel' && element.classList.contains('absolute')
  );
  if (!panel) throw new Error('ActionMenu panel did not open');
  return panel;
}

describe('ActionMenu panel geometry', () => {
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    host?.remove();
    host = null;
  });

  test.skipIf(!hasDom)('keeps the default width for unrelated consumers', async () => {
    const panel = await renderMenu();
    expect(panel.classList.contains('w-56')).toBe(true);
    expect(panel.classList.contains('w-64')).toBe(false);
  });

  test.skipIf(!hasDom)('offers an opt-in wide panel for three-mode pickers', async () => {
    const panel = await renderMenu('wide');
    expect(panel.classList.contains('w-64')).toBe(true);
    expect(panel.classList.contains('w-56')).toBe(false);
  });
});
