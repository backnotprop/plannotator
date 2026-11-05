/**
 * A sent `#Shape`'s preview (approval "board-hashtags") on a touch screen and
 * for a screen reader. What regresses: the first tap going to the Board
 * instead of previewing, the second tap not going, Escape not closing it, the
 * tag not saying its preview is open (`aria-expanded`, `aria-controls`), or a
 * column badge read as "In review2".
 *
 * Hover and focus timing are RefHoverCard's, guarded there; placement needs a
 * layout (the build's shots).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxCardWire, InboxInitiative } from '@plannotator/core/inbox-types';
import type { InitiativeTags } from './hashtags';

const hasDom = typeof document !== 'undefined';
const { InitiativeTagsContext, initiativeHref } = (hasDom ? await import('./hashtags') : {}) as typeof import('./hashtags');
const { useInitiativePeek } = (hasDom ? await import('./components/InitiativePeek') : {}) as typeof import('./components/InitiativePeek');

const SHAPE = { id: 'ini_shape', name: 'Shape', created_at: '', created_by: { kind: 'person' }, updated_at: '', deleted_at: null } as InboxInitiative;
const card = (id: string, column: InboxCardWire['column']) =>
  ({ id, title: id, column, project_id: 'prj_a', initiative: SHAPE.id, threads: [], heard_at: '2026-11-04T10:00:00Z' }) as unknown as InboxCardWire;
const TAGS: InitiativeTags = {
  initiatives: [SHAPE],
  counts: new Map(),
  cards: [card('a', 'in_review'), card('b', 'in_review'), card('c', 'done')],
  rows: new Map(),
  projects: new Map(),
  mentions: new Map(),
};

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  window.location.hash = '';
});

/** A message body as Thread draws it: the tag's link, and Thread's click rule (a tap previews first). */
function Body() {
  const ref = useRef<HTMLDivElement>(null);
  const peek = useInitiativePeek(ref);
  return (
    <div
      className="pn-inbox"
      ref={ref}
      onClickCapture={(event) => {
        const link = (event.target as Element).closest('a[href^="#board&initiative="]');
        if (!link) return;
        event.preventDefault();
        if (peek.tapOpens(link)) return;
        window.location.hash = link.getAttribute('href')!;
      }}
    >
      {peek.node}
      <p>
        Part of <a href={initiativeHref(SHAPE.id)}>#Shape</a>
      </p>
    </div>
  );
}

function tap(el: Element) {
  act(() => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    (el as HTMLElement).click();
  });
}

test.if(hasDom)('a touch screen: the first tap previews, the second goes to the Board; Escape closes; the tag says it is open', () => {
  window.location.hash = '#thread=msg_here';
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <InitiativeTagsContext.Provider value={TAGS}>
        <Body />
      </InitiativeTagsContext.Provider>,
    ),
  );
  const tag = document.querySelector('a[href^="#board&initiative="]')!;
  tap(tag);
  const peek = document.querySelector('[data-tag-peek]')!;
  expect(peek).not.toBeNull();
  expect(window.location.hash).toBe('#thread=msg_here');
  expect(tag.getAttribute('aria-expanded')).toBe('true');
  expect(tag.getAttribute('aria-controls')).toBe(peek.id);
  // Each badge reads as its words: "In review 2", not "In review2".
  expect([...peek.querySelectorAll('[data-tag-peek-columns] li')].map((li) => li.textContent!.replace(/ /g, ' '))).toEqual(['In review 2', 'Done 1']);

  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  expect(document.querySelector('[data-tag-peek]')).toBeNull();
  expect(tag.getAttribute('aria-expanded')).toBe('false');

  tap(tag);
  expect(document.querySelector('[data-tag-peek]')).not.toBeNull();
  tap(tag);
  expect(window.location.hash).toBe(initiativeHref(SHAPE.id));
});
