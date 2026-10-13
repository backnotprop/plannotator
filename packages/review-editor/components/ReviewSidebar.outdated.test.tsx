/**
 * Outdated PR comments in the review sidebar (DOM_TESTS=1, #1590).
 *
 * Outdated comments are not drawn on the diff, so the sidebar is their only
 * surface. Regressions guarded:
 *  - the card is still listed and carries the "Outdated" marker (and a
 *    current comment does not);
 *  - it stays editable from the card (the diff's inline editor cannot reach
 *    it) and the edit commits trimmed text once;
 *  - it stays deletable;
 *  - current comments gain no sidebar edit affordance (unchanged UI).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeAnnotation } from '@plannotator/ui/types';
import { ReviewSidebar } from './ReviewSidebar';

const hasDom = typeof document !== 'undefined';

const base: CodeAnnotation = {
  id: 'fresh',
  type: 'comment',
  scope: 'line',
  filePath: 'src/a.ts',
  lineStart: 3,
  lineEnd: 3,
  side: 'new',
  text: 'current remark',
  createdAt: 1,
};
const OUTDATED: CodeAnnotation = { ...base, id: 'stale', lineStart: 9, lineEnd: 9, text: 'stale remark', outdated: true };

let root: Root | null = null;
let host: HTMLElement | null = null;
let edits: Array<[string, string]> = [];
let deletes: string[] = [];

async function render(annotations: CodeAnnotation[]): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ReviewSidebar
        isOpen
        onClose={() => {}}
        activeTab="annotations"
        annotations={annotations}
        files={[]}
        selectedAnnotationId={null}
        onSelectAnnotation={() => {}}
        onNavigateToAnnotation={() => {}}
        onDeleteAnnotation={(id) => deletes.push(id)}
        onEditAnnotationText={(id, text) => edits.push([id, text])}
      />,
    );
  });
}

function card(text: string): HTMLElement {
  const el = [...document.querySelectorAll<HTMLElement>('div.group')].find((d) => d.textContent?.includes(text));
  if (!el) throw new Error(`no card for ${text}`);
  return el;
}

function button(scope: HTMLElement, title: string): HTMLButtonElement | null {
  return scope.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  edits = [];
  deletes = [];
  if (hasDom) document.body.replaceChildren();
});

describe.if(hasDom)('outdated comments in the review sidebar', () => {
  test('only the outdated card is marked, and only it gains an edit action', async () => {
    await render([base, OUTDATED]);
    expect(card('stale remark').querySelector('[data-annotation-outdated]')).not.toBeNull();
    expect(card('current remark').querySelector('[data-annotation-outdated]')).toBeNull();
    expect(button(card('current remark'), 'Edit')).toBeNull();
    expect(button(card('stale remark'), 'Edit')).not.toBeNull();
  });

  test('editing an outdated comment commits the trimmed text once', async () => {
    await render([OUTDATED]);
    await act(async () => button(card('stale remark'), 'Edit')!.click());
    const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit comment"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(input, '  revised remark  ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save')!;
    await act(async () => save.click());
    expect(edits).toEqual([['stale', 'revised remark']]);
    expect(document.querySelector('textarea[aria-label="Edit comment"]')).toBeNull();
  });

  test('an outdated comment can still be deleted', async () => {
    await render([OUTDATED]);
    await act(async () => button(card('stale remark'), 'Delete')!.click());
    expect(deletes).toEqual(['stale']);
  });
});
