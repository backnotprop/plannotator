import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import { CompactPlanStage } from './CompactPlanStage';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

describe.if(hasDom)('CompactPlanStage', () => {
  test('owns visible-viewport geometry, initial focus, Escape, and tab containment', async () => {
    let closeCount = 0;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <CompactPlanStage
          id="test-stage"
          title="Annotations"
          subtitle="plan.md"
          onClose={() => { closeCount += 1; }}
        >
          <button type="button">First action</button>
          <button type="button">Last action</button>
        </CompactPlanStage>,
      );
    });

    const stage = document.querySelector<HTMLElement>('[data-pn-compact-plan-stage="true"]');
    const close = document.querySelector<HTMLButtonElement>('button[aria-label="Close Annotations"]');
    const buttons = Array.from(stage?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    if (!stage || !close) throw new Error('Compact stage did not render');

    expect(stage.className).toContain('pn-visible-viewport-stage');
    // A transient task surface must not print over the document (print.css
    // hides [data-print-hide]).
    expect(stage.hasAttribute('data-print-hide')).toBe(true);
    expect(stage.getAttribute('role')).toBe('dialog');
    expect(stage.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(close);

    const last = buttons[buttons.length - 1];
    if (!last) throw new Error('Compact stage did not render its last action');
    last.focus();
    await act(async () => {
      last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(document.activeElement).toBe(close);

    await act(async () => {
      stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(closeCount).toBe(1);
  });

  test('lets an editing child consume Escape without dismissing the stage', async () => {
    let closeCount = 0;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <CompactPlanStage id="editing-stage" title="Annotations" onClose={() => { closeCount += 1; }}>
          <textarea
            aria-label="Edit annotation"
            onKeyDown={(event) => {
              if (event.key === 'Escape') event.preventDefault();
            }}
          />
        </CompactPlanStage>,
      );
    });

    const textarea = document.querySelector<HTMLTextAreaElement>('textarea');
    if (!textarea) throw new Error('Editing control did not render');
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(closeCount).toBe(0);
  });
});
