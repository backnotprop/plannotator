/**
 * `mentionSource` on the annotation card's EDIT box, against the REAL
 * AnnotationPanel (DOM-gated).
 *
 * What these catch: an `@` menu that never opens in the edit box (or opens
 * without a host source), a pick that inserts the wrong bytes or forgets the
 * id, the card's own Mod+Enter / Escape handlers fighting the menu for the
 * same keystroke, a blocked person whose token gets inserted anyway — and
 * the two that matter most for the field itself: a pick-less save that
 * writes `mentions` (which would wipe tags the annotation already carries),
 * and an edit box that grows an `@` listener or a `mentions` key when no
 * host supplied a source.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { AnnotationPanel } from './AnnotationPanel';
import { AnnotationType, type Annotation } from '../types';
import type { MentionPerson, MentionSource } from '../utils/mentions';

const hasDom = typeof document !== 'undefined';

const person = (over: Partial<MentionPerson> & { id: string; label: string }): MentionPerson => ({
  kind: 'user',
  detail: null,
  canOpen: true,
  ...over,
});

const PEOPLE: MentionPerson[] = [
  person({ id: 'user_1', label: 'Marcus Chen', detail: 'marcus@example.com' }),
  person({ id: 'user_2', label: 'Dana Ruiz', detail: 'dana@example.com' }),
  person({ id: 'user_3', label: 'Priya Nair', canOpen: false }),
];

const ANNOTATION: Annotation = {
  id: 'a1',
  blockId: 'b1',
  startOffset: 0,
  endOffset: 5,
  type: AnnotationType.COMMENT,
  text: 'ping',
  originalText: 'hello world',
  createdA: 1700000000000,
  author: 'brave-yam-tater',
};

let root: Root | null = null;
let host: HTMLElement | null = null;

interface Edits {
  updates: Array<Partial<Annotation>>;
}

async function mountEditing(mentionSource: MentionSource | undefined, edits: Edits) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <AnnotationPanel
        isOpen
        blocks={[]}
        annotations={[ANNOTATION]}
        selectedId={null}
        onSelect={() => {}}
        onDelete={() => {}}
        onEdit={(_id, updates) => { edits.updates.push(updates); }}
        mentionSource={mentionSource}
      />,
    );
  });
  await act(async () => {});
  const pencil = document.querySelector<HTMLButtonElement>('button[title="Edit annotation"]');
  if (!pencil) throw new Error('the card rendered no edit affordance');
  await act(async () => { pencil.click(); });
  await act(async () => {});
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

function editBox(): HTMLTextAreaElement {
  const el = document.querySelector<HTMLTextAreaElement>('[data-annotation-id] textarea');
  if (!el) throw new Error('the card is not in edit mode');
  return el;
}

async function type(el: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  await act(async () => {
    if (setter) setter.call(el, value);
    else el.value = value;
    el.selectionStart = el.selectionEnd = value.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function press(el: HTMLTextAreaElement, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  await act(async () => { el.dispatchEvent(event); });
  return event;
}

const picker = () => document.querySelector('[data-mention-picker]');
const options = () =>
  Array.from(document.querySelectorAll('[data-mention-option]')).map(
    (b) => b.getAttribute('data-mention-option')!,
  );

describe.if(hasDom)('AnnotationPanel card edit box mentionSource', () => {
  test('WITHOUT a source: @ opens nothing, no mention DOM or ARIA, save is exactly { text }', async () => {
    const edits: Edits = { updates: [] };
    await mountEditing(undefined, edits);
    const el = editBox();
    expect(el.hasAttribute('aria-autocomplete')).toBe(false);
    expect(el.hasAttribute('aria-haspopup')).toBe(false);
    expect(el.hasAttribute('aria-controls')).toBe(false);
    expect(el.hasAttribute('aria-owns')).toBe(false);
    expect(el.hasAttribute('aria-activedescendant')).toBe(false);
    await type(el, 'ping @ma');
    expect(picker()).toBeNull();
    // Enter is still a newline: nothing consumed it.
    const enter = await press(el, 'Enter');
    expect(enter.defaultPrevented).toBe(false);
    await press(el, 'Enter', { metaKey: true });
    expect(edits.updates.length).toBe(1);
    expect(Object.keys(edits.updates[0])).toEqual(['text']);
    expect(edits.updates[0].text).toBe('ping @ma');
  });

  test('WITH a source: @ opens the people list and wires aria-controls while open', async () => {
    const edits: Edits = { updates: [] };
    await mountEditing({ people: PEOPLE }, edits);
    const el = editBox();
    expect(el.getAttribute('aria-autocomplete')).toBe('list');
    expect(el.hasAttribute('aria-controls')).toBe(false); // nothing open yet
    await type(el, 'ping @ma');
    expect(picker()).not.toBeNull();
    expect(options()).toEqual(['user_1']);
    const listboxId = el.getAttribute('aria-controls');
    expect(listboxId).not.toBeNull();
    expect(document.getElementById(listboxId!)).toBe(picker() as HTMLElement);
    expect(el.hasAttribute('aria-activedescendant')).toBe(false); // nothing preselected
  });

  test('Enter alone with nothing preselected still does what it did before', async () => {
    const edits: Edits = { updates: [] };
    await mountEditing({ people: PEOPLE }, edits);
    const el = editBox();
    await type(el, 'ping @ma');
    const enter = await press(el, 'Enter');
    expect(enter.defaultPrevented).toBe(false);
    expect(el.value).toBe('ping @ma');
    expect(edits.updates).toEqual([]);
  });

  test('ArrowDown + Enter inserts the token; Mod+Enter then saves { text, mentions }', async () => {
    const seen: string[][] = [];
    const edits: Edits = { updates: [] };
    await mountEditing({ people: PEOPLE, onMentionsChange: (ids) => seen.push([...ids]) }, edits);
    const el = editBox();
    await type(el, 'ping @mar');
    await press(el, 'ArrowDown');
    expect(el.getAttribute('aria-activedescendant')).toBe(`${el.getAttribute('aria-controls')}-option-0`);
    const enter = await press(el, 'Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(el.value).toBe('ping @Marcus Chen ');
    expect(picker()).toBeNull();
    expect(seen.at(-1)).toEqual(['user_1']);

    await press(el, 'Enter', { metaKey: true });
    expect(edits.updates.length).toBe(1);
    expect(edits.updates[0]).toEqual({ text: 'ping @Marcus Chen ', mentions: ['user_1'] });
  });

  test('a source with no pick saves { text } — never mentions: []', async () => {
    const edits: Edits = { updates: [] };
    await mountEditing({ people: PEOPLE }, edits);
    const el = editBox();
    await type(el, 'just words');
    await press(el, 'Enter', { metaKey: true });
    expect(edits.updates.length).toBe(1);
    expect(Object.keys(edits.updates[0])).toEqual(['text']);
    expect('mentions' in edits.updates[0]).toBe(false);
  });

  test('deleting the token before save drops the id and saves { text }', async () => {
    const edits: Edits = { updates: [] };
    await mountEditing({ people: PEOPLE }, edits);
    const el = editBox();
    await type(el, 'ping @dan');
    await press(el, 'ArrowDown');
    await press(el, 'Enter');
    expect(el.value).toBe('ping @Dana Ruiz ');
    await type(el, 'never mind');
    await press(el, 'Enter', { metaKey: true });
    expect(edits.updates.length).toBe(1);
    expect(edits.updates[0]).toEqual({ text: 'never mind' });
  });

  test('Escape closes the picker first; only a second Escape cancels the edit', async () => {
    const edits: Edits = { updates: [] };
    await mountEditing({ people: PEOPLE }, edits);
    const el = editBox();
    await type(el, 'ping @mar');
    expect(picker()).not.toBeNull();
    await press(el, 'Escape');
    expect(picker()).toBeNull();
    expect(document.querySelector('[data-annotation-id] textarea')).not.toBeNull();
    await press(editBox(), 'Escape');
    expect(document.querySelector('[data-annotation-id] textarea')).toBeNull();
    expect(edits.updates).toEqual([]);
  });

  test('a blocked person inserts nothing when the host supplied onPickBlocked', async () => {
    const blocked: string[] = [];
    const edits: Edits = { updates: [] };
    await mountEditing({ people: PEOPLE, onPickBlocked: (p) => blocked.push(p.id) }, edits);
    const el = editBox();
    await type(el, 'ping @pri');
    await press(el, 'ArrowDown');
    await press(el, 'Enter');
    expect(blocked).toEqual(['user_3']);
    expect(el.value).toBe('ping @pri');
    expect(picker()).toBeNull();
  });

  test('a pick is scoped to ONE edit session: reopening the editor saves { text } again', async () => {
    const edits: Edits = { updates: [] };
    await mountEditing({ people: PEOPLE }, edits);
    let el = editBox();
    await type(el, 'ping @mar');
    await press(el, 'ArrowDown');
    await press(el, 'Enter');
    await press(el, 'Enter', { metaKey: true });
    expect(edits.updates[0]).toEqual({ text: 'ping @Marcus Chen ', mentions: ['user_1'] });

    // The panel is presentation-only, so the annotation prop did not change;
    // what matters is that the second session starts with nobody picked.
    const pencil = document.querySelector<HTMLButtonElement>('button[title="Edit annotation"]')!;
    await act(async () => { pencil.click(); });
    await act(async () => {});
    el = editBox();
    await type(el, 'ping @Marcus Chen and more');
    await press(el, 'Enter', { metaKey: true });
    expect(edits.updates[1]).toEqual({ text: 'ping @Marcus Chen and more' });
  });

  test('the Save button carries the same mentions the keyboard save does', async () => {
    const edits: Edits = { updates: [] };
    await mountEditing({ people: PEOPLE }, edits);
    const el = editBox();
    await type(el, 'ping @dan');
    await press(el, 'ArrowDown');
    await press(el, 'Enter');
    const save = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-annotation-id] button'))
      .find((b) => b.textContent === 'Save');
    expect(save).toBeDefined();
    await act(async () => { save!.click(); });
    expect(edits.updates[0]).toEqual({ text: 'ping @Dana Ruiz ', mentions: ['user_2'] });
  });
});
