import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Settings } from './Settings';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

const expectedSections = {
  plan: ['general', 'theme', 'display', 'saving', 'labels', 'vim', 'shortcuts', 'hooks', 'files', 'obsidian', 'bear', 'octarine'],
  review: ['general', 'theme', 'git', 'display', 'analysis', 'comments', 'ai', 'shortcuts', 'files'],
  annotate: ['general', 'theme', 'vim', 'shortcuts', 'files'],
} as const;

async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  });
}

async function mountSettings(
  mode: 'plan' | 'review' | 'annotate',
  options: {
    compact?: boolean;
    returnFocusRef?: React.RefObject<HTMLButtonElement | null>;
  } = {},
): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <Settings
        taterMode={false}
        onTaterModeChange={() => {}}
        mode={mode}
        externalOpen
        isCompactTouchLayout={options.compact ?? true}
        returnFocusRef={options.returnFocusRef}
        aiProviders={mode === 'review'
          ? [{ id: 'test', name: 'Test provider', capabilities: {} }]
          : []
        }
      />,
    );
  });
  await nextFrame();
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Expected element: ${selector}`);
  return element;
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) {
    document.body.replaceChildren();
    window.localStorage.clear();
  }
});

describe.if(hasDom)('compact touch Settings', () => {
  for (const mode of ['plan', 'review', 'annotate'] as const) {
    test(`${mode} exposes every section through the mobile information architecture`, async () => {
      await mountSettings(mode);

      const dialog = requireElement<HTMLElement>('[data-pn-settings-layout="compact"]');
      expect(dialog.getAttribute('data-pn-settings-screen')).toBe('sections');
      expect(dialog.closest('.pn-visible-viewport-stage')).not.toBeNull();
      expect(document.querySelectorAll('[data-pn-settings-scroll-owner]')).toHaveLength(1);

      const sectionIds = Array.from(
        document.querySelectorAll<HTMLElement>('[data-pn-settings-section]'),
        (element) => element.dataset.pnSettingsSection,
      );
      expect(sectionIds).toEqual([...expectedSections[mode]]);

      for (const sectionId of expectedSections[mode]) {
        const section = requireElement<HTMLButtonElement>(`[data-pn-settings-section="${sectionId}"]`);
        await act(async () => section.click());
        await nextFrame();

        expect(dialog.getAttribute('data-pn-settings-screen')).toBe('detail');
        expect(requireElement('[data-pn-settings-section-content]').getAttribute('data-pn-settings-section-content')).toBe(sectionId);
        expect(document.querySelector('[aria-label="Close settings"]')).toBeNull();

        const back = requireElement<HTMLButtonElement>('[aria-label="Back to Settings"]');
        await act(async () => back.click());
        await nextFrame();
        expect(dialog.getAttribute('data-pn-settings-screen')).toBe('sections');
        const activeElement = document.activeElement;
        expect(activeElement instanceof HTMLElement ? activeElement.dataset.pnSettingsSection : undefined).toBe(sectionId);
      }
    });
  }

  test('focus starts on Close, stays contained, Escape closes, and focus returns', async () => {
    const returnButton = document.createElement('button');
    returnButton.textContent = 'Options';
    document.body.appendChild(returnButton);
    returnButton.focus();
    const returnFocusRef = { current: returnButton };

    await mountSettings('plan', { returnFocusRef });

    const close = requireElement<HTMLButtonElement>('[aria-label="Close settings"]');
    expect(document.activeElement).toBe(close);
    expect(document.activeElement?.tagName).not.toBe('INPUT');

    const lastSection = requireElement<HTMLButtonElement>('[data-pn-settings-section="octarine"]');
    lastSection.focus();
    await act(async () => {
      lastSection.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(document.activeElement).toBe(close);

    await act(async () => {
      close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await nextFrame();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(returnButton);
  });
});

describe.if(hasDom)('desktop Settings control', () => {
  test('keeps the existing centered desktop dialog and tab composition', async () => {
    await mountSettings('plan', { compact: false });

    const dialog = requireElement<HTMLElement>('[data-pn-settings-layout="desktop"]');
    expect(dialog.classList.contains('max-w-2xl')).toBe(true);
    expect(dialog.classList.contains('max-h-[85vh]')).toBe(true);
    expect(document.querySelector('[data-pn-settings-section]')).toBeNull();
    expect(document.querySelector('.pn-visible-viewport-stage')).toBeNull();
    expect(document.body.textContent).toContain('Your Identity');
  });
});

test('compact CSS enforces touch targets, 16px editing controls, and reduced motion', async () => {
  const css = await Bun.file(new URL('../theme.css', import.meta.url)).text();
  expect(css).toContain("[data-pn-settings-layout='compact'] button:not([role='switch'])");
  expect(css).toContain('min-block-size: var(--pn-touch-target)');
  expect(css).toContain("[data-pn-settings-layout='compact'] [role='switch']::before");
  expect(css).toContain('font-size: 1rem !important');
  expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  expect(css).toContain('transition-duration: 0.01ms !important');
});
