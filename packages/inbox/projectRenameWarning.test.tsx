/**
 * The rename warning (approval "project-combine"): a typed name that is another
 * project's asks to combine, with Cancel and Combine and no way to keep both.
 * The real ProjectRow, driven through its own menu; only the window's two
 * callbacks are stand-ins, recording what the field asked for.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ProjectFolder } from './api';
import type { LabeledProject } from './projectLabels';

const hasDom = typeof document !== 'undefined';
const { ProjectRow } = (hasDom ? await import('./components/ProjectRow') : {}) as typeof import('./components/ProjectRow');

const SITE = { id: 'prj_site', name: 'docs-site', root: '/code/docs-site', slug: 'docs-site', key: 'k', created_at: '2026-10-31T00:00:00Z' } as unknown as ProjectFolder;
const DOCS = { id: 'prj_docs', name: 'docs', root: '/code/docs' };
const CODE = { id: 'prj_code', name: 'acme · code', root: '/code/acme' };
const SPACES = { id: 'prj_spaces', name: 'acme · workspaces', root: '/workspaces/acme' };

let root: Root | null = null;
let host: HTMLElement | null = null;
let saved: string[] = [];
let combined: string[] = [];
let said: string[] = [];

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  saved = [];
  combined = [];
  said = [];
  document.body.innerHTML = '';
});

const field = () => document.querySelector<HTMLInputElement>('[data-project-name-field]');
const clash = () => document.querySelector<HTMLElement>('[data-project-clash]');
const cancel = () => document.querySelector<HTMLButtonElement>('[data-project-combine-cancel]');
const combineFor = (id: string) => document.querySelector<HTMLButtonElement>(`[data-project-combine="${id}"]`);

/** The row with the given other projects, its field open through ⋯ and Rename…. */
async function openField(others: readonly LabeledProject[], combine: ((into: LabeledProject) => Promise<boolean>) | null = async (into) => {
  combined.push(into.id);
  return true;
}) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <ProjectRow
        project={SITE}
        count={1}
        on={false}
        held={false}
        readable
        phone={false}
        onOpen={() => {}}
        onAction={() => {}}
        announce={(text) => said.push(text)}
        onRename={async (name) => {
          saved.push(String(name));
          return true;
        }}
        others={others}
        onCombine={combine ?? undefined}
      />,
    );
  });
  const more = document.querySelector<HTMLElement>('.ib-pmore')!;
  await act(async () => {
    more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    more.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    more.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    more.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    more.click();
  });
  const item = document.querySelector<HTMLElement>('[data-project-action="rename"]')!;
  await act(async () => {
    item.click();
  });
  expect(field()).not.toBeNull();
}

/** Types as a person does: React's own value setter, then the input event. */
async function type(text: string) {
  const input = field()!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function key(el: HTMLElement, name: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  });
}

test.skipIf(!hasDom)('a name another project has asks, in words, and says so to a screen reader', async () => {
  await openField([DOCS]);
  expect(clash()).toBeNull();
  await type('notes');
  expect(clash()).toBeNull();
  await type('Docs');
  expect(clash()!.querySelector('span')!.textContent).toBe('docs already exists. Combine them?');
  expect([...clash()!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Cancel', 'Combine']);
  expect(said).toEqual(['docs already exists. Enter combines them, Escape cancels.']);
  expect(document.getElementById(field()!.getAttribute('aria-describedby')!)!.textContent).toContain('Enter combines them');
  // The line goes as soon as the name is no longer another project's.
  await type('Docs2');
  expect(clash()).toBeNull();
});

test.skipIf(!hasDom)('Enter combines and never saves the name; Combine does the same', async () => {
  await openField([DOCS]);
  await type('docs');
  await key(field()!, 'Enter');
  expect(combined).toEqual([DOCS.id]);
  expect(saved).toEqual([]);
  expect(field()).toBeNull();
});

test.skipIf(!hasDom)('the Combine button combines; a refused combine leaves the field open with the typed name', async () => {
  await openField([DOCS], async (into) => {
    combined.push(into.id);
    return false;
  });
  await type('docs');
  await act(async () => {
    combineFor(DOCS.id)!.click();
  });
  expect(combined).toEqual([DOCS.id]);
  expect(field()!.value).toBe('docs');
  expect(document.activeElement).toBe(field());
});

test.skipIf(!hasDom)('Cancel closes the field, changes nothing, and gives focus back to ⋯', async () => {
  await openField([DOCS]);
  await type('docs');
  await act(async () => {
    cancel()!.click();
  });
  expect(field()).toBeNull();
  expect(document.activeElement).toBe(document.querySelector('.ib-pmore'));
  expect([saved, combined]).toEqual([[], []]);
});

test.skipIf(!hasDom)('Escape in the field cancels, changes nothing, and gives focus back to ⋯', async () => {
  await openField([DOCS]);
  await type('docs');
  await key(field()!, 'Escape');
  expect(field()).toBeNull();
  expect(document.activeElement).toBe(document.querySelector('.ib-pmore'));
  expect([saved, combined]).toEqual([[], []]);
});

test.skipIf(!hasDom)('Tab to Cancel or Combine keeps the field, and Escape from a button still cancels', async () => {
  await openField([DOCS]);
  await type('docs');
  await act(async () => {
    cancel()!.focus();
  });
  expect(field()).not.toBeNull();
  await act(async () => {
    combineFor(DOCS.id)!.focus();
  });
  expect(field()).not.toBeNull();
  await key(combineFor(DOCS.id)!, 'Escape');
  expect(field()).toBeNull();
  expect([saved, combined]).toEqual([[], []]);
});

test.skipIf(!hasDom)('leaving for somewhere else closes the field and leaves focus there', async () => {
  await openField([DOCS]);
  await type('docs');
  const outside = document.createElement('button');
  document.body.appendChild(outside);
  await act(async () => {
    outside.focus();
  });
  expect(field()).toBeNull();
  expect(document.activeElement).toBe(outside);
  expect([saved, combined]).toEqual([[], []]);
});

test.skipIf(!hasDom)('a press on Combine does not take focus from the field, so the field never closes under the pointer', async () => {
  await openField([DOCS]);
  await type('docs');
  const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
  await act(async () => {
    combineFor(DOCS.id)!.dispatchEvent(press);
  });
  expect(press.defaultPrevented).toBe(true);
});

test.skipIf(!hasDom)('a name several projects answer to offers each, and Enter leaves the choice to the person', async () => {
  await openField([DOCS, CODE, SPACES]);
  await type('acme');
  expect(clash()!.querySelector('span')!.textContent).toBe('acme matches 2 projects. Combine with one?');
  expect([...clash()!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Cancel', 'acme · code', 'acme · workspaces']);
  await key(field()!, 'Enter');
  expect([saved, combined]).toEqual([[], []]);
  expect(field()).not.toBeNull();
  await act(async () => {
    combineFor(SPACES.id)!.click();
  });
  expect(combined).toEqual([SPACES.id]);
});

test.skipIf(!hasDom)('the project\'s own name opens no warning, even when another project reads the same', async () => {
  await openField([{ id: 'prj_same', name: 'docs-site', root: '/old/docs-site' }]);
  expect(clash()).toBeNull();
  await key(field()!, 'Enter');
  expect(field()).toBeNull();
  expect([saved, combined]).toEqual([[], []]);
});

test.skipIf(!hasDom)('without Combine (a window that cannot combine) a name saves as it always did', async () => {
  await openField([DOCS], null);
  await type('docs');
  expect(clash()).toBeNull();
  await key(field()!, 'Enter');
  await act(async () => {
    await Promise.resolve();
  });
  expect(saved).toEqual(['docs']);
});
