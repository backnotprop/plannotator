/**
 * The `mentionSource` seam against the REAL CommentPopover (DOM-gated).
 *
 * What these catch: an `@` menu that never opens (or opens on an email), a
 * pick that inserts the wrong bytes or forgets the id, a blocked person whose
 * token gets inserted anyway, ids that keep being reported after the author
 * deleted the token — and the one that matters for Plannotator: the composer
 * growing an `@` listener, a portal, or a third submit argument when no host
 * supplied a source.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MentionPerson, MentionSource } from '../utils/mentions';

const hasDom = typeof document !== 'undefined';

// CommentPopover imports DOM-reading modules; load lazily so this file stays
// inert in the DOM-less default `bun test` run.
const popoverMod = hasDom ? await import('./CommentPopover') : null;
const CommentPopover =
  popoverMod?.CommentPopover as typeof import('./CommentPopover')['CommentPopover'];

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

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

interface Submitted {
  args: unknown[];
}

async function mountPopover(
  mentionSource: MentionSource | undefined,
  submitted: Submitted,
) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <CommentPopover
        anchorRect={new DOMRect(100, 400, 60, 20)}
        contextText="selected text"
        isGlobal={false}
        onSubmit={(...args: unknown[]) => { submitted.args = args; }}
        onClose={() => {}}
        mentionSource={mentionSource}
      />,
    );
  });
  await act(async () => {});
}

function textarea(): HTMLTextAreaElement {
  const el = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea');
  if (!el) throw new Error('CommentPopover textarea did not render');
  return el;
}

async function type(el: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  await act(async () => {
    if (setter) setter.call(el, value);
    else el.value = value;
    el.selectionStart = el.selectionEnd = value.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: value.slice(-1) || 'a', bubbles: true }));
  });
}

async function press(el: HTMLTextAreaElement, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  await act(async () => { el.dispatchEvent(event); });
  return event;
}

function picker(): Element | null {
  return document.querySelector('[data-mention-picker]');
}

function options(): string[] {
  return Array.from(document.querySelectorAll('[data-mention-option]')).map(
    (b) => b.getAttribute('data-mention-option')!,
  );
}

describe.if(hasDom)('CommentPopover mentionSource seam', () => {
  test('WITHOUT a source, typing @ opens nothing and submit stays a two-argument call', async () => {
    const submitted: Submitted = { args: [] };
    await mountPopover(undefined, submitted);
    const el = textarea();
    await type(el, 'ping @ma');
    expect(picker()).toBeNull();
    // Enter is still a newline, and nothing was consumed.
    const enter = await press(el, 'Enter');
    expect(enter.defaultPrevented).toBe(false);
    await press(el, 'Enter', { metaKey: true });
    expect(submitted.args.length).toBe(2);
    expect(submitted.args[0]).toBe('ping @ma');
  });

  test('typing @ opens the people list; an email never does', async () => {
    const submitted: Submitted = { args: [] };
    await mountPopover({ people: PEOPLE }, submitted);
    const el = textarea();
    await type(el, 'write to a@b.co');
    expect(picker()).toBeNull();
    await type(el, 'ping @');
    expect(picker()).not.toBeNull();
    expect(options()).toEqual(['user_1', 'user_2', 'user_3']);
    await type(el, 'ping @dan');
    expect(options()).toEqual(['user_2']);
  });

  test('nothing is preselected: Enter stays a newline until an arrow engages a row', async () => {
    const submitted: Submitted = { args: [] };
    await mountPopover({ people: PEOPLE }, submitted);
    const el = textarea();
    await type(el, 'ping @mar');
    expect(document.querySelector('[aria-selected="true"]')).toBeNull();
    const enter = await press(el, 'Enter');
    expect(enter.defaultPrevented).toBe(false);
    expect(el.value).toBe('ping @mar');
  });

  test('ArrowDown + Enter inserts the readable token, reports the id, and submits it', async () => {
    const seen: string[][] = [];
    const submitted: Submitted = { args: [] };
    await mountPopover(
      { people: PEOPLE, onMentionsChange: (ids) => seen.push([...ids]) },
      submitted,
    );
    const el = textarea();
    await type(el, 'ping @mar');
    await press(el, 'ArrowDown');
    const enter = await press(el, 'Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(el.value).toBe('ping @Marcus Chen ');
    expect(picker()).toBeNull();
    expect(seen.at(-1)).toEqual(['user_1']);

    await press(el, 'Enter', { metaKey: true });
    expect(submitted.args.length).toBe(3);
    expect(submitted.args[0]).toBe('ping @Marcus Chen ');
    expect(submitted.args[2]).toEqual(['user_1']);
  });

  test('deleting the token untags that person before submit', async () => {
    const seen: string[][] = [];
    const submitted: Submitted = { args: [] };
    await mountPopover(
      { people: PEOPLE, onMentionsChange: (ids) => seen.push([...ids]) },
      submitted,
    );
    const el = textarea();
    await type(el, 'ping @dan');
    await press(el, 'ArrowDown');
    await press(el, 'Enter');
    expect(seen.at(-1)).toEqual(['user_2']);
    await type(el, 'never mind');
    expect(seen.at(-1)).toEqual([]);
    await press(el, 'Enter', { metaKey: true });
    expect(submitted.args[2]).toEqual([]);
  });

  test('a blocked person inserts nothing when the host supplied onPickBlocked', async () => {
    const blocked: string[] = [];
    const submitted: Submitted = { args: [] };
    await mountPopover(
      { people: PEOPLE, onPickBlocked: (p) => blocked.push(p.id) },
      submitted,
    );
    const el = textarea();
    await type(el, 'ping @pri');
    await press(el, 'ArrowDown');
    await press(el, 'Enter');
    expect(blocked).toEqual(['user_3']);
    expect(el.value).toBe('ping @pri'); // nothing inserted
    expect(picker()).toBeNull();
  });

  test('without onPickBlocked a canOpen:false person inserts like anyone else', async () => {
    const submitted: Submitted = { args: [] };
    await mountPopover({ people: PEOPLE }, submitted);
    const el = textarea();
    await type(el, 'ping @pri');
    await press(el, 'ArrowDown');
    await press(el, 'Enter');
    expect(el.value).toBe('ping @Priya Nair ');
  });

  test('a heading renders above the list only when the source supplies one', async () => {
    const submitted: Submitted = { args: [] };
    await mountPopover({ people: PEOPLE, heading: 'People in this workspace' }, submitted);
    await type(textarea(), 'ping @');
    const heading = document.querySelector('[data-mention-heading]');
    expect(heading).not.toBeNull();
    expect(heading!.textContent).toBe('People in this workspace');
    expect(options()).toEqual(['user_1', 'user_2', 'user_3']);
  });

  test('no heading and no avatars without the optional fields', async () => {
    const submitted: Submitted = { args: [] };
    await mountPopover({ people: PEOPLE }, submitted);
    await type(textarea(), 'ping @');
    expect(document.querySelector('[data-mention-heading]')).toBeNull();
    expect(document.querySelector('[data-mention-avatar]')).toBeNull();
  });

  test('avatars render before the label: an image when url is set, else initials on a disc', async () => {
    const submitted: Submitted = { args: [] };
    await mountPopover({
      people: [
        person({ id: 'u1', label: 'Marcus Chen', avatar: { url: 'https://example.test/m.png' } }),
        person({ id: 'u2', label: 'Dana Ruiz', avatar: { initials: 'DR', tint: 'rgb(10, 20, 30)' } }),
        person({ id: 'u3', label: 'Priya Nair', avatar: {} }),
      ],
    }, submitted);
    await type(textarea(), 'ping @');
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-mention-option]'));
    expect(rows.map((r) => r.querySelector('[data-mention-avatar]')?.getAttribute('data-mention-avatar')))
      .toEqual(['image', 'initials', 'initials']);
    expect(rows[0]!.querySelector('img')!.getAttribute('src')).toBe('https://example.test/m.png');
    const dana = rows[1]!.querySelector<HTMLElement>('[data-mention-avatar]')!;
    expect(dana.textContent).toBe('DR');
    expect(dana.style.backgroundColor).toBe('rgb(10, 20, 30)');
    // No initials given: the first letter of the label, uppercased.
    expect(rows[2]!.querySelector('[data-mention-avatar]')!.textContent).toBe('P');
    // The avatar precedes the label in DOM order.
    const first = rows[0]!.firstElementChild!;
    expect(first.getAttribute('data-mention-avatar')).toBe('image');
  });

  test('an empty people list shows the honest-empty notice and is not navigable', async () => {
    const submitted: Submitted = { args: [] };
    await mountPopover({ people: [], emptyNotice: 'Mentions need a team workspace' }, submitted);
    const el = textarea();
    await type(el, 'ping @');
    expect(picker()).not.toBeNull();
    expect(document.querySelector('[data-mention-empty]')?.textContent)
      .toBe('Mentions need a team workspace');
    expect(options()).toEqual([]);
    const enter = await press(el, 'Enter');
    expect(enter.defaultPrevented).toBe(false);
  });

  test('an empty people list with NO notice keeps the menu closed', async () => {
    const submitted: Submitted = { args: [] };
    await mountPopover({ people: [] }, submitted);
    await type(textarea(), 'ping @');
    expect(picker()).toBeNull();
  });

  test('Escape closes the menu without closing the composer', async () => {
    const submitted: Submitted = { args: [] };
    await mountPopover({ people: PEOPLE }, submitted);
    const el = textarea();
    await type(el, 'ping @mar');
    expect(picker()).not.toBeNull();
    await press(el, 'Escape');
    expect(picker()).toBeNull();
    expect(document.querySelector('[data-comment-popover]')).not.toBeNull();
  });

  test('a mouse pick inserts the token', async () => {
    const submitted: Submitted = { args: [] };
    await mountPopover({ people: PEOPLE }, submitted);
    const el = textarea();
    await type(el, 'ping @dan');
    await act(async () => {
      document
        .querySelector('[data-mention-option="user_2"]')!
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    expect(el.value).toBe('ping @Dana Ruiz ');
  });
});
