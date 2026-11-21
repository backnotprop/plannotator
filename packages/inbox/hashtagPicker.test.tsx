/**
 * The `#` picker (approval "board-hashtags") as the person uses it. What
 * regresses: a row picked before it was arrowed onto (Enter must keep its
 * meaning), a reply pick that does not write `#Shape` for the agent to read,
 * and New card keeping the tag in the title or not setting the card's
 * initiative (cards show no mark, so the title carries none).
 *
 * The reply box's list is placed by FloatingSkillMenu, which needs a layout
 * happy-dom does not do; its words and keys are the hook's, driven here on a
 * plain field. The list's look is in the build's shots.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxInitiative } from '@plannotator/core/inbox-types';
import type { InitiativeTags } from './hashtags';
import type { NewCardInput } from './board/NewCardDialog';

const hasDom = typeof document !== 'undefined';
const { NewCardDialog } = (hasDom ? await import('./board/NewCardDialog') : {}) as typeof import('./board/NewCardDialog');
const { useHashtagPicker } = (hasDom ? await import('./hashtags') : {}) as typeof import('./hashtags');
const { HashtagFieldMenu } = (hasDom ? await import('./components/HashtagFieldMenu') : {}) as typeof import('./components/HashtagFieldMenu');

const ini = (id: string, name: string): InboxInitiative => ({ id, name, created_at: '', created_by: { kind: 'person' }, updated_at: '', deleted_at: null }) as InboxInitiative;
const SHAPE = ini('ini_shape', 'Shape');
const REVIEW = ini('ini_review', 'Code review');
const TAGS: InitiativeTags = { initiatives: [SHAPE, REVIEW], counts: new Map([[SHAPE.id, 4]]), cards: [], rows: new Map(), projects: new Map(), mentions: new Map() };
const PROJECT = { id: 'prj_1', name: 'web', root: '/home/me/web', key: 'web-1a2b3c', created_at: '2026-11-01T10:00:00.000Z', threads: 0, unread: 0 };

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function render(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

/** Typed with the caret at the end, as a browser leaves it. */
function type(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  act(() => {
    el.focus();
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, text);
    el.setSelectionRange(text.length, text.length);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function key(el: HTMLElement, name: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  });
}

/** Each row's name and its quiet count (inbox.css hides the skill list's source column for `#`). */
const options = () =>
  [...document.querySelectorAll('[role="option"]')].map((o) => [o.querySelector('[data-skill-item-part="name"]')?.textContent, o.querySelector('[data-skill-item-part="description"]')?.textContent]);

/** A reply-like field: the hook without `onPick`, its list as New card draws it. */
function Reply({ onValue }: { onValue: (value: string) => void }) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const hash = useHashtagPicker({ text: value, setText: (next) => (setValue(next), onValue(next)), fieldRef: ref, tags: TAGS });
  return (
    <div className="ib-hashwrap">
      {hash.menu && <HashtagFieldMenu id="reply-hash" field={ref.current} menu={hash.menu} onSelect={hash.select} />}
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          onValue(e.target.value);
          hash.onSelect();
        }}
        onKeyDown={(e) => {
          if (hash.onKeyDown(e)) e.stopPropagation();
        }}
      />
    </div>
  );
}

test.if(hasDom)('a reply: # lists the initiatives; Enter does nothing until a row is arrowed onto; the pick writes #CodeReview for the agent', () => {
  let value = '';
  render(<Reply onValue={(v) => (value = v)} />);
  const field = document.querySelector('textarea')!;
  type(field, 'Part of #');
  expect(options()).toEqual([
    ['Shape', '4'],
    ['Code review', '0'],
  ]);
  // Nothing active: Enter is the field's own (here, nothing changes).
  key(field, 'Enter');
  expect(value).toBe('Part of #');
  type(field, 'Part of #co');
  expect(options()).toEqual([['Code review', '0']]);
  key(field, 'ArrowDown');
  key(field, 'Enter');
  expect(value).toBe('Part of #CodeReview ');
  expect(document.querySelector('[role="listbox"]')).toBeNull();
  // A query nothing matches closes the list.
  type(field, 'Part of #CodeReview and #zz');
  expect(document.querySelector('[role="listbox"]')).toBeNull();
});

test.if(hasDom)('New card: a pick sets the card initiative, shown as its token, and the tag leaves the title', async () => {
  const made: NewCardInput[] = [];
  render(
    <NewCardDialog
      projects={[PROJECT]}
      defaultProject={PROJECT.id}
      sessions={null}
      home="/home/me"
      phone={false}
      initiatives={[SHAPE, REVIEW]}
      onClose={() => {}}
      onCreate={async (input) => {
        made.push(input);
        return null;
      }}
    />,
  );
  const title = document.querySelector<HTMLInputElement>('[data-new-card-title]')!;
  expect(document.querySelector('[data-new-card-initiative]')).toBeNull();
  type(title, 'Empty states #sh');
  expect(title.getAttribute('aria-expanded')).toBe('true');
  key(title, 'ArrowDown');
  key(title, 'Enter');
  expect(title.value).toBe('Empty states');
  expect(document.querySelector('[data-new-card-initiative]')!.getAttribute('data-new-card-initiative')).toBe(SHAPE.id);
  expect(document.querySelector('[data-new-card-initiative] .ib-bflt-tok-l')!.textContent).toBe('Shape');
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[data-new-card-add]')!.click();
  });
  expect(made.map((m) => [m.title, m.initiative])).toEqual([['Empty states', SHAPE.id]]);
});
