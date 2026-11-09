/**
 * HostTitle: ui's own hover text. Off (the default, every host but the
 * Plannotator Inbox, Workspaces included) it is the native `title` exactly as
 * before: no tooltip, no added aria-label or aria-describedby, an empty title
 * kept. On (`componentTooltips`) it is ui's Tooltip: no native title, a title
 * that was the control's only name becomes its aria-label, and any other title
 * stays readable as the control's description (a hidden element named by
 * aria-describedby, since the tooltip itself tags nothing).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const mod = (hasDom ? await import('./HostTitle') : null) as typeof import('./HostTitle') | null;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  mod?.resetComponentTooltips();
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(node: React.ReactNode): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

function controls(): React.ReactNode {
  const { HostTitle } = mod!;
  return (
    <div>
      <HostTitle title="Delete annotation" name>
        <button type="button" data-k="name">
          x
        </button>
      </HostTitle>
      <HostTitle title="This comment no longer matches a location in the document">
        <span data-k="desc">Unanchored</span>
      </HostTitle>
      <HostTitle title="Record as a decision">
        <button type="button" aria-label="Record as a decision" data-k="same">
          ◆
        </button>
      </HostTitle>
      <HostTitle title="">
        <span data-k="empty">e</span>
      </HostTitle>
      <HostTitle title={undefined}>
        <span data-k="none">n</span>
      </HostTitle>
    </div>
  );
}

const el = (root: HTMLElement, k: string) => root.querySelector<HTMLElement>(`[data-k="${k}"]`)!;

test.skipIf(!hasDom)('off (the default): every wrapper keeps the native title and adds no aria-label or description', () => {
  expect(mod!.getComponentTooltips()).toBe(false);
  const r = render(controls());
  expect(el(r, 'name').getAttribute('title')).toBe('Delete annotation');
  expect(el(r, 'desc').getAttribute('title')).toBe('This comment no longer matches a location in the document');
  expect(el(r, 'same').getAttribute('title')).toBe('Record as a decision');
  // An empty title still renders, as it did before HostTitle.
  expect(el(r, 'empty').getAttribute('title')).toBe('');
  expect(el(r, 'none').hasAttribute('title')).toBe(false);
  for (const k of ['name', 'desc', 'empty', 'none']) {
    expect(el(r, k).hasAttribute('aria-label')).toBe(false);
    expect(el(r, k).hasAttribute('aria-describedby')).toBe(false);
  }
  expect(el(r, 'same').hasAttribute('aria-describedby')).toBe(false);
  expect(r.querySelectorAll('[data-host-title-description]').length).toBe(0);
  // The markup is the plain children, nothing wrapped around them.
  expect(r.firstElementChild!.children.length).toBe(5);
});

test.skipIf(!hasDom)('on: no native title; a name becomes the aria-label; a description stays readable through aria-describedby', () => {
  mod!.setComponentTooltips(true);
  const r = render(controls());
  for (const k of ['name', 'desc', 'same', 'empty', 'none']) expect(el(r, k).hasAttribute('title')).toBe(false);
  expect(el(r, 'name').getAttribute('aria-label')).toBe('Delete annotation');
  expect(el(r, 'name').hasAttribute('aria-describedby')).toBe(false);
  const described = document.getElementById(el(r, 'desc').getAttribute('aria-describedby') ?? '');
  expect(described?.textContent).toBe('This comment no longer matches a location in the document');
  expect(described?.hidden).toBe(true);
  // A title equal to the control's own label is not repeated as its description.
  expect(el(r, 'same').hasAttribute('aria-describedby')).toBe(false);
});
