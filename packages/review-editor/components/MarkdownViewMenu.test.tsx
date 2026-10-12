/**
 * The one control a Markdown file has: a header button naming its view that
 * opens a menu Source / Changes / Read. A real menu for a keyboard and a
 * screen reader (radio items with aria-checked, arrows, Home/End, type-ahead,
 * Escape back to the button); added and deleted files offer Source and Read
 * only; on a phone the same choices, in the same words, open as a sheet.
 *
 * DOM-gated (DOM_TESTS=1) and registered in .github/workflows/test.yml's
 * "Run UI seam-contract + DOM tests" step.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MarkdownViewMenu, type MarkdownViewMenuProps } from './MarkdownViewMenu';
import { MARKDOWN_FILE_VIEWS, type MarkdownFileView } from '../utils/markdownPreview';

const hasDom = typeof document !== 'undefined';

let root: Root | null = null;
let host: HTMLElement | null = null;
const chosen: MarkdownFileView[] = [];

function Harness(props: Partial<MarkdownViewMenuProps>) {
  const [view, setView] = useState<MarkdownFileView>(props.view ?? 'source');
  return (
    <MarkdownViewMenu
      filePath="docs/getting-started.md"
      views={MARKDOWN_FILE_VIEWS}
      {...props}
      view={view}
      onChoose={(next) => {
        chosen.push(next);
        setView(next);
      }}
    />
  );
}

async function mount(props: Partial<MarkdownViewMenuProps> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<Harness {...props} />));
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
const trigger = () => document.querySelector<HTMLButtonElement>('[data-markdown-view-menu]')!;
const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const items = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'));
const names = () => items().map((item) => item.getAttribute('data-markdown-view-option'));

async function open() {
  await act(async () => trigger().click());
  await settle();
}

async function key(target: Element, keyName: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true }));
  });
  await settle();
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  chosen.length = 0;
  document.body.innerHTML = '';
});

describe.if(hasDom)('MarkdownViewMenu', () => {
  test('the button names the view; the menu offers Source, Changes and Read with the current one checked', async () => {
    await mount({ view: 'changes' });
    expect(trigger().textContent).toContain('Changes');
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger().getAttribute('aria-label')).toBe('Changes view of getting-started.md');

    await open();
    expect(menu()).not.toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(names()).toEqual(['source', 'changes', 'read']);
    expect(items().map((item) => item.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
  });

  test('picking a view reports it, closes the menu and relabels the button', async () => {
    await mount();
    await open();
    await act(async () => items()[2].click());
    await settle();
    expect(chosen).toEqual(['read']);
    expect(menu()).toBeNull();
    expect(trigger().textContent).toContain('Read');
    expect(trigger().getAttribute('data-markdown-view')).toBe('read');
  });

  test('keyboard: arrows, Home/End and type-ahead move through the views; Escape returns to the button', async () => {
    await mount();
    await act(async () => trigger().focus());
    await key(trigger(), 'ArrowDown');
    expect(menu()).not.toBeNull();
    const highlighted = () => document.activeElement?.getAttribute('data-markdown-view-option');
    expect(highlighted()).toBe('source');

    await key(document.activeElement!, 'ArrowDown');
    expect(highlighted()).toBe('changes');
    await key(document.activeElement!, 'End');
    expect(highlighted()).toBe('read');
    await key(document.activeElement!, 'Home');
    expect(highlighted()).toBe('source');
    await key(document.activeElement!, 'r');
    expect(highlighted()).toBe('read');

    await key(document.activeElement!, 'Escape');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(chosen).toEqual([]);
  });

  test('an added or deleted file offers Source and Read only, and Read says which version', async () => {
    await mount({ views: ['source', 'read'], status: 'deleted' });
    await open();
    expect(names()).toEqual(['source', 'read']);
    expect(items()[1].textContent).toContain('The deleted version, rendered');
  });

  test('while the file holds the edit session the button is disabled, says why, and opens nothing', async () => {
    await mount({ disabledReason: 'Finish editing first' });
    expect(trigger().disabled).toBe(true);
    expect(trigger().getAttribute('title')).toBe('Finish editing first');
    await open();
    expect(menu()).toBeNull();
    expect(chosen).toEqual([]);
  });

  test('on a phone the same words open as a sheet titled with the file', async () => {
    await mount({ touch: true, view: 'changes' });
    await open();
    const sheet = document.querySelector('[data-markdown-view-popup]');
    expect(sheet?.getAttribute('data-markdown-view-popup')).toBe('sheet');
    expect(sheet?.textContent).toContain('Show getting-started.md as');
    expect(items().map((item) => item.querySelector('span > span')?.textContent)).toEqual(['Source', 'Changes', 'Read']);
    await act(async () => items()[0].click());
    await settle();
    expect(chosen).toEqual(['source']);
  });
});
