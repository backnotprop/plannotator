import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReviewAnalysisIntroDialog } from './ReviewAnalysisIntroDialog';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

function Harness({ onDismiss = () => {} }: { onDismiss?: () => void }) {
  const [semantic, setSemantic] = useState(true);
  const [callFlow, setCallFlow] = useState(false);
  const [open, setOpen] = useState(true);
  return (
    <ReviewAnalysisIntroDialog
      isOpen={open}
      semanticChangesEnabled={semantic}
      callFlowEnabled={callFlow}
      onSemanticChangesChange={setSemantic}
      onCallFlowChange={setCallFlow}
      onDismiss={() => { onDismiss(); setOpen(false); }}
    />
  );
}

async function mount(onDismiss?: () => void) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<Harness onDismiss={onDismiss} />));
}

describe('ReviewAnalysisIntroDialog', () => {
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    if (hasDom) document.body.replaceChildren();
  });

  test.skipIf(!hasDom)('presents both settings side by side as independent switches', async () => {
    await mount();
    const dialog = document.querySelector('[data-review-analysis-intro-dialog]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.textContent).toContain('Semantic changes');
    expect(dialog?.textContent).toContain('Call flow');
    expect(dialog?.textContent).toContain('New');
    expect(dialog?.textContent).toContain('sendReceipt()');
    expect(dialog?.textContent).toContain('completeOrder()');
    expect(dialog?.textContent).toContain('checkout.ts:118');
    expect(dialog?.textContent).toContain('Powered by CallDiff, created by');
    expect(dialog?.textContent).toContain('Settings → Analysis');

    const examples = Array.from(dialog?.querySelectorAll<HTMLElement>('figure[role="img"]') ?? []);
    expect(examples).toHaveLength(2);
    expect(examples.every((example) => Boolean(example.getAttribute('aria-label')))).toBe(true);

    const callFlowSection = dialog?.querySelector<HTMLElement>('section[aria-label="Call flow"]');
    expect(callFlowSection?.className).toContain('border-primary/35');
    const creatorLink = callFlowSection?.querySelector<HTMLAnchorElement>(
      'a[href="https://github.com/tanishqkancharla"]',
    );
    expect(creatorLink?.target).toBe('_blank');
    expect(creatorLink?.rel).toContain('noopener');

    const switches = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="switch"]'));
    expect(switches).toHaveLength(2);
    expect(switches.map((control) => control.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    await act(async () => switches[1].click());
    expect(switches[1].getAttribute('aria-checked')).toBe('true');
  });

  test.skipIf(!hasDom)('uses the existing announcement shell', async () => {
    await mount();
    const backdrop = document.querySelector('[data-review-analysis-intro-backdrop]');
    const dialog = document.querySelector('[data-review-analysis-intro-dialog]');
    expect(backdrop?.className).toContain('bg-background/90');
    expect(backdrop?.className).toContain('backdrop-blur-sm');
    expect(dialog?.className).toContain('max-w-5xl');
    expect(dialog?.className).toContain('rounded-xl');
    expect(dialog?.className).toContain('shadow-2xl');
  });

  test.skipIf(!hasDom)('Got it dismisses the one-time chooser', async () => {
    const onDismiss = mock(() => {});
    await mount(onDismiss);
    const primaryAction = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Got it');
    expect(document.activeElement).toBe(primaryAction);
    await act(async () => primaryAction?.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  test.skipIf(!hasDom)('Escape dismisses the one-time chooser', async () => {
    const onDismiss = mock(() => {});
    await mount(onDismiss);
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
