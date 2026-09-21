import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button as LegacyButton } from '../core/button';
import { Button } from './button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog';

const hasDom = typeof document !== 'undefined';

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(ui: React.ReactElement): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(ui));
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

describe('shared mobile control foundation', () => {
  test('keeps target expansion and press feedback inside the compact touch shell', () => {
    const theme = readFileSync(resolve(import.meta.dir, '../../theme.css'), 'utf8');

    expect(theme).toContain('--pn-touch-target: 2.75rem');
    expect(theme).toContain("html:has([data-pn-compact-touch-layout='true'])");
    expect(theme).toContain('min-block-size: var(--pn-touch-target)');
    expect(theme).toContain('min-inline-size: var(--pn-touch-target)');
    expect(theme).toContain('touch-action: manipulation');
    expect(theme).not.toContain('@media (any-pointer: coarse)');
    expect(theme).toContain('@media (prefers-reduced-motion: reduce)');
  });

  test('marks canonical buttons without changing their visual size classes', () => {
    const labelled = renderToStaticMarkup(<Button size="xxs">Save</Button>);
    const icon = renderToStaticMarkup(<Button size="icon" aria-label="Close" />);

    expect(labelled).toContain('data-pn-touch-target="true"');
    expect(labelled).not.toContain('data-pn-touch-target-icon');
    expect(labelled).toContain('h-6');
    expect(icon).toContain('data-pn-touch-target-icon="true"');
    expect(icon).toContain('size-9');
  });

  test('marks legacy buttons and identifies icon-only variants', () => {
    const labelled = renderToStaticMarkup(<LegacyButton size="sm">Skip</LegacyButton>);
    const icon = renderToStaticMarkup(
      <LegacyButton size="icon" variant="icon" aria-label="Options" />,
    );

    expect(labelled).toContain('data-pn-touch-target="true"');
    expect(labelled).not.toContain('data-pn-touch-target-icon');
    expect(labelled).toContain('h-8');
    expect(icon).toContain('data-pn-touch-target-icon="true"');
    expect(icon).toContain('h-8 w-8');
  });

  test.skipIf(!hasDom)('centers shared dialogs inside the observed safe visible viewport', async () => {
    await mount(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Mobile-safe dialog</DialogTitle>
          <DialogDescription>Representative content</DialogDescription>
        </DialogContent>
      </Dialog>,
    );

    const visibleViewport = document.querySelector<HTMLElement>('.pn-visible-viewport-overlay');
    const popup = document.querySelector<HTMLElement>('[role="dialog"]');
    const close = document.querySelector<HTMLButtonElement>('button[data-pn-touch-target-icon]');

    expect(visibleViewport).not.toBeNull();
    expect(visibleViewport?.className).toContain('pointer-events-none');
    expect(popup?.className).toContain('pointer-events-auto');
    expect(popup?.className).toContain('max-h-[min(640px,85vh,100%)]');
    expect(close?.getAttribute('data-pn-touch-target')).toBe('true');
    expect(close?.getAttribute('aria-label')).toBeNull();
    expect(close?.textContent).toContain('Close');
  });
});
