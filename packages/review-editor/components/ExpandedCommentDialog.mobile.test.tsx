import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const dialogModule = hasDom ? await import('./ExpandedCommentDialog') : null;
const ExpandedCommentDialog = dialogModule?.ExpandedCommentDialog as typeof import('./ExpandedCommentDialog')['ExpandedCommentDialog'];

let host: HTMLElement | null = null;
let root: Root | null = null;

async function mount(ui: React.ReactElement): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(ui));
  await act(async () => new Promise(resolve => setTimeout(resolve, 0)));
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

describe('ExpandedCommentDialog mobile composition', () => {
  test.skipIf(!hasDom)('uses visible bounds, the mobile editable marker, and no forced focus', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Line 12';
    document.body.appendChild(trigger);
    trigger.focus();

    let suggestionOpens = 0;
    await mount(
      <ExpandedCommentDialog
        title="Line 12"
        commentText=""
        setCommentText={() => {}}
        isEditing={false}
        canSubmit={false}
        onSubmit={() => {}}
        onCollapse={() => {}}
        onCancel={() => {}}
        autoFocus={false}
        collapsible={false}
        onEditSuggestion={() => { suggestionOpens += 1; }}
      />,
    );

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const overlay = document.querySelector<HTMLElement>('.pn-visible-viewport-overlay');
    const textarea = document.querySelector<HTMLTextAreaElement>('[data-pn-mobile-editable="true"]');
    expect(dialog).not.toBeNull();
    expect(overlay).not.toBeNull();
    expect(dialog?.classList.contains('pn-responsive-composer-dialog')).toBe(true);
    expect(dialog?.classList.contains('pn-review-composer-dialog')).toBe(true);
    expect(textarea).not.toBeNull();
    expect(document.querySelector('button[aria-label="Collapse expanded comment"]')).toBeNull();
    expect(document.activeElement).not.toBe(textarea);
    const suggestButton = Array.from(document.querySelectorAll('button'))
      .find(button => button.textContent?.trim() === 'Suggest code');
    expect(suggestButton).not.toBeNull();
    await act(async () => suggestButton?.click());
    expect(suggestionOpens).toBe(1);
  });
});
