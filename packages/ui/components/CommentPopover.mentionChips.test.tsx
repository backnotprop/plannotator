/**
 * `@Label` tokens rendered as CHIPS in the composer, against the REAL
 * CommentPopover (DOM-gated).
 *
 * What these catch: a pick that inserts a token the overlay does not paint
 * (so a tag looks different in the input than in the picker row and in the
 * host's posted comment), a chip that outlives the token it names when the
 * author edits it, a chip whose span covers more or fewer bytes than the
 * token (the caret would drift from the painted text), the two token sources
 * fighting over one overlay — and the one that matters for Plannotator: an
 * overlay element existing at all when no host supplied a source.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MentionPerson, MentionSource } from '../utils/mentions';
import type { SkillCatalogEntry } from '../utils/skillReferences';

const hasDom = typeof document !== 'undefined';

// CommentPopover imports DOM-reading modules; load lazily so this file stays
// inert in the DOM-less default `bun test` run.
const popoverMod = hasDom ? await import('./CommentPopover') : null;
const CommentPopover =
  popoverMod?.CommentPopover as typeof import('./CommentPopover')['CommentPopover'];
const catalogMod = hasDom ? await import('../utils/skillCatalog') : null;

const person = (over: Partial<MentionPerson> & { id: string; label: string }): MentionPerson => ({
  kind: 'user',
  detail: null,
  canOpen: true,
  ...over,
});

const PEOPLE: MentionPerson[] = [
  person({ id: 'user_1', label: 'Marcus Chen', detail: 'marcus@example.com' }),
  person({ id: 'user_2', label: 'Dana Ruiz', detail: 'dana@example.com' }),
];

const CATALOG: SkillCatalogEntry[] = [
  { name: 'humanizer', root: 'universal', humanOnly: false },
];

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  if (!hasDom) return;
  catalogMod!.resetSkillCatalogCache();
  catalogMod!.setSkillCatalogTransport(async () => CATALOG);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  if (hasDom) document.body.replaceChildren();
});

async function mountPopover(
  props: Partial<React.ComponentProps<typeof CommentPopover>> = {},
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
        onSubmit={() => {}}
        onClose={() => {}}
        {...props}
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

/** The mirrored highlight layer, or null when the composer has no sources. */
function overlay(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-pn-mobile-editable-mirror]');
}

function chips(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-mention-token]'));
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

/** Type `@<query>`, arrow onto the first row and take it. */
async function pick(el: HTMLTextAreaElement, typed: string) {
  await type(el, typed);
  await press(el, 'ArrowDown');
  await press(el, 'Enter');
  // The pick restores focus and the caret in a macrotask; let it land so a
  // following keystroke reads the caret the composer actually has.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe.if(hasDom)('CommentPopover mention chips', () => {
  test('WITHOUT any source there is no overlay element at all', async () => {
    await mountPopover();
    await type(textarea(), 'ping @Marcus Chen please');
    expect(overlay()).toBeNull();
    expect(chips()).toEqual([]);
  });

  test('a mentionSource turns the overlay on before anything is picked', async () => {
    // The overlay's lifetime is the composer's, so the first pick never swaps
    // the textarea element under the caret.
    await mountPopover({ mentionSource: { people: PEOPLE } });
    expect(overlay()).not.toBeNull();
    expect(chips()).toEqual([]);
    // It is presentation only and names no skill-reference layer.
    expect(overlay()!.getAttribute('aria-hidden')).toBe('true');
    expect(overlay()!.getAttribute('data-skill-ref-overlay')).toBeNull();
  });

  test('a pick renders ONE chip whose text is exactly the inserted token', async () => {
    await mountPopover({ mentionSource: { people: PEOPLE } });
    const el = textarea();
    await pick(el, 'Nice catch @ma');
    expect(el.value).toBe('Nice catch @Marcus Chen ');

    const painted = chips();
    expect(painted.length).toBe(1);
    expect(painted[0]!.getAttribute('data-mention-token')).toBe('user_1');
    expect(painted[0]!.getAttribute('data-mention-kind')).toBe('user');
    // Exactly the token — not the trailing space, not the words before it.
    expect(painted[0]!.textContent).toBe('@Marcus Chen');
    // And the overlay still paints the whole value, chip included.
    expect(overlay()!.textContent).toBe(`${el.value}\n`);
  });

  test('two picks chip both, in document order', async () => {
    await mountPopover({ mentionSource: { people: PEOPLE } });
    const el = textarea();
    await pick(el, 'ping @ma');
    await pick(el, `${el.value}and @dan`);
    expect(el.value).toBe('ping @Marcus Chen and @Dana Ruiz ');
    expect(chips().map((c) => c.textContent)).toEqual(['@Marcus Chen', '@Dana Ruiz']);
    expect(chips().map((c) => c.getAttribute('data-mention-token'))).toEqual([
      'user_1',
      'user_2',
    ]);
  });

  test('deleting a character un-chips the token and drops the id', async () => {
    const seen: string[][] = [];
    await mountPopover({
      mentionSource: { people: PEOPLE, onMentionsChange: (ids) => seen.push([...ids]) },
    });
    const el = textarea();
    await pick(el, 'ping @ma');
    expect(chips().length).toBe(1);
    expect(seen.at(-1)).toEqual(['user_1']);

    // One byte out of the middle of the token: no partial chip survives.
    await type(el, 'ping @Marcus Chn ');
    expect(chips()).toEqual([]);
    expect(seen.at(-1)).toEqual([]);
    // The text is still painted in full; only the highlight went away.
    expect(overlay()!.textContent).toBe('ping @Marcus Chn \n');
  });

  test('skill-reference tokens and mention chips coexist in one overlay', async () => {
    await mountPopover({ skillReferences: true, mentionSource: { people: PEOPLE } });
    const el = textarea();
    await pick(el, 'see $humanizer and ping @ma');
    expect(el.value).toBe('see $humanizer and ping @Marcus Chen ');

    const layers = document.querySelectorAll('[data-pn-mobile-editable-mirror]');
    expect(layers.length).toBe(1); // ONE overlay, two sources
    expect(document.querySelector('[data-skill-ref-token]')!.textContent).toBe('$humanizer');
    expect(chips().map((c) => c.textContent)).toEqual(['@Marcus Chen']);
    // Document order inside the single layer: skill token first.
    const spans = Array.from(layers[0]!.querySelectorAll('span'));
    expect(spans.map((s) => s.textContent)).toEqual(['$humanizer', '@Marcus Chen']);
  });

  test('the host class is appended to the chip, never replacing the default', async () => {
    await mountPopover({
      mentionSource: { people: PEOPLE, tokenClassName: 'host-chip' },
    });
    await pick(textarea(), 'ping @ma');
    const cls = chips()[0]!.className;
    expect(cls.split(/\s+/)).toContain('host-chip');
    expect(cls.split(/\s+/)).toContain('bg-primary/15');
  });

  test('IME composition hides the overlay and shows the textarea text again', async () => {
    await mountPopover({ mentionSource: { people: PEOPLE } });
    const el = textarea();
    await pick(el, 'ping @ma');
    expect(overlay()!.style.visibility).toBe('');
    expect(el.className).not.toContain('pn-ref-composing');

    await act(async () => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
    expect(overlay()!.style.visibility).toBe('hidden');
    expect(el.className).toContain('pn-ref-composing');

    await act(async () => {
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });
    expect(overlay()!.style.visibility).toBe('');
    expect(chips().length).toBe(1);
  });

  test('the expanded (dialog) composer chips through the same component', async () => {
    await mountPopover({ mentionSource: { people: PEOPLE } });
    const expand = Array.from(document.querySelectorAll('button')).find(
      (b) => b.getAttribute('title') === 'Expand',
    );
    expect(expand).toBeTruthy();
    await act(async () => { expand!.click(); });
    await act(async () => {});
    // Still exactly one composer, now the dialog one.
    expect(document.querySelectorAll('[data-comment-popover] textarea').length).toBe(1);
    await pick(textarea(), 'ping @dan');
    expect(chips().map((c) => c.getAttribute('data-mention-token'))).toEqual(['user_2']);
    expect(chips()[0]!.textContent).toBe('@Dana Ruiz');
  });

  test('Mod+Enter still submits the body with the surviving ids', async () => {
    const submitted: unknown[][] = [];
    await mountPopover({
      mentionSource: { people: PEOPLE },
      onSubmit: (...args: unknown[]) => submitted.push(args),
    });
    const el = textarea();
    await pick(el, 'ping @ma');
    await press(el, 'Enter', { metaKey: true });
    expect(submitted.length).toBe(1);
    expect(submitted[0]![0]).toBe('ping @Marcus Chen ');
    expect(submitted[0]![2]).toEqual(['user_1']);
  });
});

describe.if(hasDom)('mentionSource forwarded by the viewers reaches the chips', () => {
  // Viewer/HtmlViewer forward `mentionSource` to the composers they mount
  // (0.43.1) and needed no change for chips; this pins that the prop the
  // viewers pass is the same one the chip layer reads.
  test('a composer mounted with a viewer-shaped source chips a pick', async () => {
    const source: MentionSource = { people: PEOPLE, heading: 'People here' };
    await mountPopover({ mentionSource: source, isGlobal: true });
    await pick(textarea(), 'ping @dan');
    expect(chips()[0]!.getAttribute('data-mention-token')).toBe('user_2');
  });
});
