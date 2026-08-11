/**
 * Skill-reference keyboard state machine, against the REAL CommentPopover.
 *
 * The load-bearing invariant here is NO PRESELECTION: the menu opens on a
 * bare `/` or `$` (full catalog), but with NOTHING active — and while nothing
 * is active, every key behaves exactly as if the menu were not open. An
 * adversarial review PROVED the failure this prevents: "This costs $" + Enter
 * inserted a skill instead of a newline, "cd /" + Tab inserted a skill
 * instead of blurring. A row activates ONLY via arrow keys (never hover) —
 * and on a BARE trigger with zero query characters even the arrows pass
 * through to the textarea and dismiss the menu ("cost: $" + ArrowUp is caret
 * navigation, another proven regression); arrows engage the menu only once a
 * query character was typed. A click inserts directly without ever arming
 * Enter. Also covers: IME
 * composition, disarm-on-typing, Escape semantics, the highlight overlay, and
 * skillReferences={false} inertness.
 *
 * DOM-gated (DOM_TESTS=1), same harness as Viewer.consumer.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import {
  fetchSkillCatalog,
  resetSkillCatalogCache,
  resetSkillCatalogTransport,
  setSkillCatalogTransport,
} from '../utils/skillCatalog';
import type { SkillCatalogEntry } from '../utils/skillReferences';

const hasDom = typeof document !== 'undefined';

// CommentPopover imports DOM-reading modules; load lazily so this file stays
// inert in the DOM-less default `bun test` run.
const popoverMod = hasDom ? await import('./CommentPopover') : null;
const CommentPopover =
  popoverMod?.CommentPopover as typeof import('./CommentPopover')['CommentPopover'];

const catalog: SkillCatalogEntry[] = [
  { name: 'animate', root: 'claude', description: 'Motion design', humanOnly: false },
  { name: 'annotate-helper', root: 'codex', humanOnly: false },
  { name: 'humanizer', root: 'universal', humanOnly: false },
  { name: 'plannotator-review', root: 'claude', humanOnly: true },
];

let root: Root | null = null;
let host: HTMLElement | null = null;
let closed = 0;

async function mountPopover(props: Partial<React.ComponentProps<typeof CommentPopover>> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  closed = 0;
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <CommentPopover
        anchorRect={new DOMRect(100, 100, 60, 20)}
        contextText="selected text"
        isGlobal={false}
        onSubmit={() => {}}
        onClose={() => {
          closed++;
        }}
        skillReferences
        {...props}
      />,
    );
  });
  // Flush the catalog fetch effect.
  await act(async () => {});
}

beforeEach(() => {
  if (!hasDom) return;
  resetSkillCatalogCache();
  setSkillCatalogTransport(async () => catalog);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  host?.remove();
  host = null;
  if (hasDom) document.body.innerHTML = '';
  resetSkillCatalogCache();
  resetSkillCatalogTransport();
});

function textarea(): HTMLTextAreaElement {
  const el = document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea');
  if (!el) throw new Error('CommentPopover textarea did not render');
  return el;
}

async function type(el: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(el),
    'value',
  )?.set;
  await act(async () => {
    if (setter) setter.call(el, value);
    else el.value = value;
    el.selectionStart = el.selectionEnd = value.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    // Real typing ends with a keyup; React's select plugin records the caret
    // from it (and fires onSelect). Without this, the NEXT keydown sees a
    // "changed" selection and re-fires onSelect with the stale DOM caret,
    // which no real keyboard sequence produces.
    el.dispatchEvent(
      new KeyboardEvent('keyup', { key: value.slice(-1) || 'a', bubbles: true }),
    );
  });
}

async function press(
  el: HTMLTextAreaElement,
  key: string,
  init: KeyboardEventInit = {},
): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    el.dispatchEvent(event);
  });
  return event;
}

function menu(): Element | null {
  return document.querySelector('[data-skill-menu]');
}

function activeRow(): Element | null {
  return document.querySelector('[data-skill-item-active]');
}

describe('CommentPopover skill references — no-preselection keyboard state machine', () => {
  test.skipIf(!hasDom)(
    'THE regression: bare $ opens the full catalog with NOTHING active; Enter stays a newline',
    async () => {
      await mountPopover();
      const el = textarea();
      await type(el, 'This costs $');
      expect(menu()).not.toBeNull(); // bare trigger opens the catalog
      expect(document.querySelectorAll('[data-skill-item]').length).toBe(catalog.length);
      expect(activeRow()).toBeNull(); // and nothing is preselected
      const enter = await press(el, 'Enter');
      expect(enter.defaultPrevented).toBe(false); // the newline goes through
      expect(el.value).toBe('This costs $'); // no skill text appeared
    },
  );

  test.skipIf(!hasDom)('bare / opens the menu; Tab still leaves the field', async () => {
    await mountPopover();
    const el = textarea();
    await type(el, 'cd /');
    expect(menu()).not.toBeNull();
    expect(activeRow()).toBeNull();
    const tab = await press(el, 'Tab');
    expect(tab.defaultPrevented).toBe(false);
    expect(el.value).toBe('cd /');
  });

  test.skipIf(!hasDom)(
    'a typed query filters but still preselects nothing; Enter stays a newline',
    async () => {
      await mountPopover();
      const el = textarea();
      await type(el, 'use /an');
      expect(menu()).not.toBeNull();
      expect(activeRow()).toBeNull();
      const enter = await press(el, 'Enter');
      expect(enter.defaultPrevented).toBe(false);
      expect(el.value).toBe('use /an');
    },
  );

  test.skipIf(!hasDom)('ArrowDown activates the FIRST row; Enter then inserts it', async () => {
    await mountPopover();
    const el = textarea();
    await type(el, 'use /an');
    await press(el, 'ArrowDown');
    expect(activeRow()?.getAttribute('data-skill-item')).toBe('animate');
    const enter = await press(el, 'Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(el.value).toBe('use /animate ');
    expect(menu()).toBeNull();
  });

  test.skipIf(!hasDom)(
    'with a query, ArrowUp from nothing-active activates the LAST row',
    async () => {
      await mountPopover();
      const el = textarea();
      // prefix: animate, annotate-helper; substring: humanizer, plannotator-review
      await type(el, '$a');
      await press(el, 'ArrowUp');
      expect(activeRow()?.getAttribute('data-skill-item')).toBe('plannotator-review');
    },
  );

  test.skipIf(!hasDom)(
    'bare-trigger menu: ArrowUp passes through to the textarea and dismisses the menu',
    async () => {
      // The reproduced regression: in a multi-line composer, "cost: $" opens
      // the full catalog and ArrowUp was consumed — activating the LAST row so
      // the next Enter inserted a skill instead of a newline.
      await mountPopover();
      const el = textarea();
      await type(el, 'first line\ncost: $');
      expect(menu()).not.toBeNull();
      const up = await press(el, 'ArrowUp');
      expect(up.defaultPrevented).toBe(false); // caret navigation goes through
      expect(menu()).toBeNull(); // and the menu is dismissed
      expect(activeRow()).toBeNull();
      const enter = await press(el, 'Enter');
      expect(enter.defaultPrevented).toBe(false); // Enter stays a newline
      expect(el.value).toBe('first line\ncost: $'); // no skill text appeared
    },
  );

  test.skipIf(!hasDom)(
    'bare-trigger menu: ArrowDown also passes through and dismisses',
    async () => {
      await mountPopover();
      const el = textarea();
      await type(el, 'This costs $');
      expect(menu()).not.toBeNull();
      const down = await press(el, 'ArrowDown');
      expect(down.defaultPrevented).toBe(false);
      expect(menu()).toBeNull();
      expect(activeRow()).toBeNull();
    },
  );

  test.skipIf(!hasDom)(
    'one query character re-arms the arrows: ArrowDown is consumed and activates a row',
    async () => {
      await mountPopover();
      const el = textarea();
      await type(el, 'use $h');
      expect(menu()).not.toBeNull();
      const down = await press(el, 'ArrowDown');
      expect(down.defaultPrevented).toBe(true);
      expect(activeRow()?.getAttribute('data-skill-item')).toBe('humanizer');
    },
  );

  test.skipIf(!hasDom)('Tab inserts once a row is active', async () => {
    await mountPopover();
    const el = textarea();
    await type(el, '$hum');
    await press(el, 'ArrowDown');
    await press(el, 'Tab');
    expect(el.value).toBe('$humanizer ');
  });

  test.skipIf(!hasDom)('typing after activation DISARMS the active row', async () => {
    await mountPopover();
    const el = textarea();
    await type(el, '/an');
    await press(el, 'ArrowDown');
    expect(activeRow()).not.toBeNull();
    await type(el, '/ani'); // keep filtering the same trigger
    expect(menu()).not.toBeNull();
    expect(activeRow()).toBeNull(); // the activation referred to the old list
    const enter = await press(el, 'Enter');
    expect(enter.defaultPrevented).toBe(false);
    expect(el.value).toBe('/ani');
  });

  test.skipIf(!hasDom)(
    'pointer hover over a row NEVER arms Enter (the mouse rests where the menu renders)',
    async () => {
      await mountPopover();
      const el = textarea();
      await type(el, 'This costs $');
      const row = document.querySelector('[data-skill-item="animate"]')!;
      await act(async () => {
        row.dispatchEvent(new Event('pointermove', { bubbles: true }));
        row.dispatchEvent(new Event('pointerenter', { bubbles: true }));
        row.dispatchEvent(new Event('pointerover', { bubbles: true }));
      });
      expect(activeRow()).toBeNull();
      const enter = await press(el, 'Enter');
      expect(enter.defaultPrevented).toBe(false); // newline goes through
      expect(el.value).toBe('This costs $'); // no skill text appeared
    },
  );

  test.skipIf(!hasDom)('a pointer CLICK inserts directly', async () => {
    await mountPopover();
    const el = textarea();
    await type(el, 'use $');
    const row = document.querySelector('[data-skill-item="humanizer"]')!;
    await act(async () => {
      row.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    });
    expect(el.value).toBe('use $humanizer ');
    expect(menu()).toBeNull();
  });

  test.skipIf(!hasDom)(
    'Enter during IME composition never inserts, even with an active row',
    async () => {
      await mountPopover();
      const el = textarea();
      await type(el, 'use /an');
      await press(el, 'ArrowDown');
      expect(activeRow()).not.toBeNull();
      const enter = await press(el, 'Enter', { isComposing: true });
      expect(enter.defaultPrevented).toBe(false);
      expect(el.value).toBe('use /an'); // no skill inserted
      expect(menu()).not.toBeNull(); // menu untouched

      // Arrows mid-composition drive the IME candidate list, not the menu.
      const down = await press(el, 'ArrowDown', { isComposing: true });
      expect(down.defaultPrevented).toBe(false);
    },
  );

  test.skipIf(!hasDom)(
    'Escape on an unengaged bare-trigger menu passes through and closes the composer',
    async () => {
      await mountPopover();
      const el = textarea();
      await type(el, 'This costs $');
      expect(menu()).not.toBeNull();
      await press(el, 'Escape');
      expect(closed).toBe(1); // one press, as if the menu were not open
    },
  );

  test.skipIf(!hasDom)(
    'Escape after typing a query dismisses the menu; the composer stays open',
    async () => {
      await mountPopover();
      const el = textarea();
      await type(el, '/an');
      expect(menu()).not.toBeNull();
      await press(el, 'Escape');
      expect(menu()).toBeNull();
      expect(closed).toBe(0);
      expect(document.querySelector('[data-comment-popover]')).not.toBeNull();

      // With the menu dismissed, Escape closes the composer as before.
      await press(el, 'Escape');
      expect(closed).toBe(1);
    },
  );

  test.skipIf(!hasDom)(
    'Escape with an active row clears it and dismisses; the composer stays open',
    async () => {
      await mountPopover();
      const el = textarea();
      await type(el, 'use $hum'); // typed query, then engage via arrows
      await press(el, 'ArrowDown');
      expect(activeRow()).not.toBeNull();
      await press(el, 'Escape');
      expect(menu()).toBeNull();
      expect(closed).toBe(0);
      // The dismissed trigger does not reopen while the caret sits on it.
      const enter = await press(el, 'Enter');
      expect(enter.defaultPrevented).toBe(false);
      expect(el.value).toBe('use $hum');
    },
  );

  test.skipIf(!hasDom)(
    'human-only skills render identically to every other row: no badge, no disclosure, no ARIA note',
    async () => {
      // The menu no longer surfaces humanOnly at pick time (the instructions
      // ride along with the exported feedback automatically). The old
      // hover-disclosed footer changed the bottom-anchored menu's height under
      // the pointer and oscillated the hovered row every frame.
      await mountPopover();
      const el = textarea();
      await type(el, '$a'); // animate, annotate-helper, humanizer, plannotator-review
      expect(menu()).not.toBeNull();
      expect(document.querySelector('[data-skill-menu-disclosure]')).toBeNull();
      const humanOnlyRow = document.querySelector('[data-skill-item="plannotator-review"]')!;
      const plainRow = document.querySelector('[data-skill-item="animate"]')!;
      expect(humanOnlyRow.hasAttribute('data-skill-item-human-only')).toBe(false);
      expect(humanOnlyRow.hasAttribute('aria-describedby')).toBe(false);
      expect(humanOnlyRow.className).toBe(plainRow.className);
      expect(menu()!.textContent).not.toContain('human-only');
      expect(menu()!.textContent).not.toContain('cannot be invoked');
    },
  );

  test.skipIf(!hasDom)(
    'REGRESSION (hover jitter): hovering any row, human-only included, leaves the menu markup untouched',
    async () => {
      await mountPopover();
      const el = textarea();
      await type(el, 'This costs $');
      const menuEl = menu() as HTMLElement;
      const before = menuEl.outerHTML;
      for (const name of ['plannotator-review', 'animate']) {
        const row = document.querySelector(`[data-skill-item="${name}"]`)!;
        await act(async () => {
          row.dispatchEvent(new Event('pointermove', { bubbles: true }));
          row.dispatchEvent(new Event('pointerover', { bubbles: true }));
          row.dispatchEvent(new Event('pointerenter', { bubbles: true }));
        });
        // Hover must not change ANY rendered output — no class flip, no new
        // element, no style change — so the menu cannot grow, re-measure, or
        // shift the row out from under the pointer.
        expect((menu() as HTMLElement).outerHTML).toBe(before);
        expect(activeRow()).toBeNull(); // and it still never arms Enter
        await act(async () => {
          row.dispatchEvent(new Event('pointerout', { bubbles: true }));
          row.dispatchEvent(new Event('pointerleave', { bubbles: true }));
        });
        expect((menu() as HTMLElement).outerHTML).toBe(before);
      }
      const enter = await press(el, 'Enter');
      expect(enter.defaultPrevented).toBe(false);
      expect(el.value).toBe('This costs $');
    },
  );

  test.skipIf(!hasDom)('inserted references render highlighted in the composer overlay', async () => {
    await mountPopover();
    const el = textarea();
    await type(el, 'use $hum');
    await press(el, 'ArrowDown');
    await press(el, 'Enter');
    expect(el.value).toBe('use $humanizer ');
    const token = document.querySelector('[data-skill-ref-token]');
    expect(token).not.toBeNull();
    expect(token!.getAttribute('data-skill-ref-token')).toBe('humanizer');
    expect(token!.textContent).toBe('$humanizer');
    // Model-invocable tokens carry no human-only marker.
    expect(token!.hasAttribute('data-skill-ref-human-only')).toBe(false);
    // The overlay is presentation-only and must never intercept the pointer.
    const overlay = document.querySelector('[data-skill-ref-overlay]');
    expect(overlay).not.toBeNull();
    expect(overlay!.getAttribute('aria-hidden')).toBe('true');
  });

  test.skipIf(!hasDom)(
    'skillReferences={false} stays inert even with a warm catalog (no menu, no overlay, no notice)',
    async () => {
      await fetchSkillCatalog(); // warm the shared memory cache
      await mountPopover({
        skillReferences: false,
        initialText: 'use $plannotator-review please',
      });
      const el = textarea();
      expect(document.querySelector('[data-skill-human-only-notice]')).toBeNull();
      expect(document.querySelector('[data-skill-ref-overlay]')).toBeNull();
      expect(el.classList.contains('pn-ref-input')).toBe(false);
      await type(el, 'use $');
      expect(menu()).toBeNull();
      await type(el, 'use $plannotator-rev');
      expect(menu()).toBeNull();
    },
  );

  test.skipIf(!hasDom)(
    'the human-only notice renders as a quiet native disclosure with the full explanation inside',
    async () => {
      await mountPopover({ initialText: 'use $plannotator-review please' });
      const notice = document.querySelector('[data-skill-human-only-notice]');
      expect(notice).not.toBeNull();
      // A native <details> disclosure: reachable by pointer, keyboard, and AT
      // alike, collapsed to a single quiet summary line at rest.
      expect(notice!.tagName.toLowerCase()).toBe('details');
      const summary = notice!.querySelector('summary');
      expect(summary).not.toBeNull();
      expect(summary!.textContent).toContain('Includes skill instructions');
      // The accurate full sentence is the disclosed content.
      expect(notice!.textContent).toContain('plannotator-review');
      expect(notice!.textContent).toContain('cannot be invoked by a model');
      expect(notice!.textContent).toContain('included with your feedback');
      // The token itself carries the quiet inline marker.
      const token = document.querySelector('[data-skill-ref-token="plannotator-review"]');
      expect(token).not.toBeNull();
      expect(token!.getAttribute('data-skill-ref-human-only')).toBe('true');
    },
  );
});
