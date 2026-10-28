/**
 * ui's Tooltip: the owner's design-system ruling q4 (a borderless float that
 * opens after 150 ms, in every product).
 *
 * Failures to catch: the popup drawing a visible border again; the shadow token
 * it relies on going missing from theme.css (the tooltip would lose its only
 * edge); a lone Tooltip falling back to Base UI's 600 ms; a TooltipProvider
 * without props using anything but 150 ms; a host's own delay no longer winning.
 */
import React, { act } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { Tooltip, TooltipProvider, TOOLTIP_DELAY_MS, TOOLTIP_SKIP_DELAY_MS } from './Tooltip';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function render(node: React.ReactNode): HTMLButtonElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return container.querySelector('button') as HTMLButtonElement;
}

const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/** Base UI opens on pointer rest; the popup is portaled to the body. */
async function rest(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('mouseenter'));
    button.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
  });
}

const popup = () => document.querySelector<HTMLElement>('[data-pn-tooltip]');

/** Opens no sooner than `before` ms and by `after` ms of rest. */
async function expectOpensBetween(button: HTMLButtonElement, before: number, after: number): Promise<void> {
  await rest(button);
  await wait(before);
  expect(popup()).toBeNull();
  await wait(after - before);
  expect(popup()?.textContent).toBe('Label');
}

describe('Tooltip defaults', () => {
  // Pinned on purpose: the owner's ruling (q4) fixes these numbers for every product.
  test('one timing: 150 ms to open, 400 ms to the next', () => {
    expect(TOOLTIP_DELAY_MS).toBe(150);
    expect(TOOLTIP_SKIP_DELAY_MS).toBe(400);
  });

  test('theme.css defines the float shadow the tooltip draws, in dark and in light', () => {
    const css = readFileSync(join(import.meta.dir, '..', 'theme.css'), 'utf8');
    const root = css.slice(css.indexOf(':root {'), css.indexOf('html {'));
    const light = css.slice(css.indexOf('  .light {'), css.indexOf('* {'));
    expect(root).toContain('--float-shadow:');
    expect(light).toContain('--float-shadow:');
  });
});

describe.if(hasDom)('Tooltip (DOM)', () => {
  test('draws no visible border: a transparent one (kept for forced colors) and the float shadow', async () => {
    const button = render(
      <TooltipProvider delayDuration={0}>
        <Tooltip content="Label">
          <button type="button">Trigger</button>
        </Tooltip>
      </TooltipProvider>,
    );
    await rest(button);
    await wait(40);
    const classes = popup()?.className.split(/\s+/) ?? [];
    expect(classes).toContain('border-transparent');
    expect(classes).not.toContain('border-border');
    expect(classes).toContain('shadow-[var(--float-shadow)]');
  });

  test('alone (no provider) it opens after 150 ms, not Base UI 600', async () => {
    const button = render(
      <Tooltip content="Label">
        <button type="button">Trigger</button>
      </Tooltip>,
    );
    await expectOpensBetween(button, 80, 400);
  });

  test('under a provider with no props it opens after 150 ms', async () => {
    const button = render(
      <TooltipProvider>
        <Tooltip content="Label">
          <button type="button">Trigger</button>
        </Tooltip>
      </TooltipProvider>,
    );
    await expectOpensBetween(button, 80, 400);
  });

  test("a host's own delay still wins", async () => {
    const button = render(
      <TooltipProvider delayDuration={700}>
        <Tooltip content="Label">
          <button type="button">Trigger</button>
        </Tooltip>
      </TooltipProvider>,
    );
    await expectOpensBetween(button, 400, 1000);
  });

  // The Inbox shows a row badge's card while the row (not the badge) has keyboard focus.
  test('forceOpen shows it with no hover, and false hands it back to hover', async () => {
    const draw = (forceOpen: boolean) => (
      <Tooltip content="Label" forceOpen={forceOpen}>
        <button type="button">Trigger</button>
      </Tooltip>
    );
    const button = render(draw(true));
    await wait(10);
    expect(popup()?.textContent).toBe('Label');
    act(() => root?.render(draw(false)));
    await wait(10);
    expect(popup() === null || popup()!.hasAttribute('data-closed')).toBe(true);
    await rest(button);
    await wait(400);
    const open = [...document.querySelectorAll<HTMLElement>('[data-pn-tooltip]')].find((el) => !el.hasAttribute('data-closed'));
    expect(open?.textContent).toBe('Label');
  });
});
