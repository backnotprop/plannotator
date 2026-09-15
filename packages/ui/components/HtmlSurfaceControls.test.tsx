/**
 * Published HtmlSurfaceControls (DOM-gated): the pen/eye/refresh markup
 * hosts share with Plannotator's header.
 *
 * Failures to catch: a control rendering without its handler (a read-only
 * document must show no pen), the pen losing its pressed state or its
 * pixel-stable border, the refresh going inert or dropping focus while in
 * flight, the compact shell rendering chrome, the label overrides not
 * reaching the DOM, a control losing its accessible name now that `title`
 * is gone, and a tooltip that names the wrong key (or hardcodes "Cmd").
 * The default strings are pinned on purpose (see below).
 */
import React, { act } from 'react';
import { afterEach, describe, expect, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { DEFAULT_HTML_SURFACE_CONTROL_LABELS, HtmlSurfaceControls } from './HtmlSurfaceControls';
import { TooltipProvider } from './Tooltip';
import { formatShortcutBindingText, formatShortcutBindingTokens } from '../shortcuts/core';
import { htmlAnnotateShortcuts } from '../shortcuts/plan-review/htmlAnnotate.shortcuts';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function render(props: Partial<React.ComponentProps<typeof HtmlSurfaceControls>> = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      // delayDuration 0: the hover test asserts what a dwell produces, not
      // how long the app's provider makes people wait for it.
      <TooltipProvider delayDuration={0}>
        <HtmlSurfaceControls
          armed
          onToggleArmed={() => {}}
          toolsHidden={false}
          onToggleTools={() => {}}
          canRefresh
          onRefresh={() => {}}
          isRefreshing={false}
          {...props}
        />
      </TooltipProvider>,
    );
  });
  return container;
}

/** Base UI opens on pointer dwell; the portal lands outside `container`. */
async function hover(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('mouseenter'));
    button.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

async function focusTrigger(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.focus();
    button.dispatchEvent(new FocusEvent('focus'));
    button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

/** The open popup's text, or null. Base UI portals the popup out of the
 *  container and this build tags neither it nor the trigger with anything
 *  ARIA-visible — which is exactly why the shortcut is ALSO attached to the
 *  button as an aria-describedby span rather than left to the tooltip. */
function openTooltipText(): string | null {
  const portal = document.querySelector<HTMLElement>('[data-base-ui-portal]');
  return portal ? portal.textContent : null;
}

const pen = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-html-annotate-toggle]');
const eye = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-html-tools-toggle]');
const refresh = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-html-refresh]');
const back = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-html-back]');

describe.if(hasDom)('HtmlSurfaceControls', () => {
  test('each control renders only with its handler; the eye renders even without refresh', () => {
    const full = render();
    expect(pen(full)).not.toBeNull();
    expect(eye(full)).not.toBeNull();
    expect(refresh(full)).not.toBeNull();
    // Order: eye group (refresh, eye) then the pen.
    const buttons = Array.from(full.querySelectorAll('button')).map((b) => b.dataset);
    expect(buttons.map((d) => Object.keys(d)[0])).toEqual(['htmlRefresh', 'htmlToolsToggle', 'htmlAnnotateToggle']);

    act(() => root?.unmount());
    const readOnly = render({ onToggleArmed: undefined, canRefresh: false });
    expect(pen(readOnly)).toBeNull();
    expect(refresh(readOnly)).toBeNull();
    expect(eye(readOnly)).not.toBeNull();

    // A host without the tools toggle still gets the refresh it asked for:
    // the documented contract is canRefresh + onRefresh, not the eye.
    act(() => root?.unmount());
    const noTools = render({ onToggleTools: undefined });
    expect(eye(noTools)).toBeNull();
    expect(refresh(noTools)).not.toBeNull();
    expect(pen(noTools)).not.toBeNull();

    act(() => root?.unmount());
    const refreshOnly = render({ onToggleTools: undefined, onToggleArmed: undefined });
    expect(refreshOnly.querySelectorAll('button').length).toBe(1);
    expect(refresh(refreshOnly)).not.toBeNull();

    act(() => root?.unmount());
    const nothing = render({ onToggleTools: undefined, onToggleArmed: undefined, canRefresh: false });
    expect(nothing.childElementCount).toBe(0);
  });

  test('the refresh fires its handler without the eye present', () => {
    let refreshes = 0;
    const el = render({ onToggleTools: undefined, onRefresh: () => { refreshes += 1; } });
    act(() => refresh(el)!.click());
    expect(refreshes).toBe(1);
  });

  test('compact renders nothing', () => {
    const el = render({ compact: true });
    expect(el.childElementCount).toBe(0);
  });

  test('the pen reports aria-pressed and keeps a border of the same width in both states', () => {
    let toggles = 0;
    const armed = render({ armed: true, onToggleArmed: () => { toggles += 1; } });
    const armedPen = pen(armed)!;
    expect(armedPen.getAttribute('aria-pressed')).toBe('true');
    expect(armedPen.className).toContain('border-primary/60');
    act(() => armedPen.click());
    expect(toggles).toBe(1);

    act(() => root?.unmount());
    const interact = render({ armed: false });
    const interactPen = pen(interact)!;
    expect(interactPen.getAttribute('aria-pressed')).toBe('false');
    // Transparent border, same width: the box is pixel-identical.
    expect(interactPen.className).toContain('border-transparent');
    expect(interactPen.className).toContain(' border ');
    expect(armedPen.className).toContain(' border ');
  });

  test('an in-flight refresh ignores clicks without dropping focus; the eye reports pressed when hidden', () => {
    let refreshes = 0;
    const el = render({ isRefreshing: true, toolsHidden: true, onRefresh: () => { refreshes += 1; } });
    const button = refresh(el)!;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.disabled).toBe(false);
    button.focus();
    act(() => button.click());
    expect(refreshes).toBe(0);
    expect(document.activeElement).toBe(button);
    expect(eye(el)!.getAttribute('aria-pressed')).toBe('true');
  });

  test('default strings are Plannotator\'s (deliberate pin) and every control keeps an accessible name without `title`', () => {
    // DELIBERATE PIN: these strings are the package defaults every host
    // inherits, and Plannotator's own header renders them verbatim. A drift
    // here changes shipped UI in two products; change it on purpose, with
    // the maintainer, and update this test in the same commit.
    const armed = render({ armed: true, toolsHidden: false, isRefreshing: false });
    // `title` is gone (the Tooltip replaced it); the name it used to supply
    // has to still be there, or these become unnamed icon buttons.
    expect(pen(armed)!.title).toBe('');
    expect(eye(armed)!.title).toBe('');
    expect(refresh(armed)!.title).toBe('');
    expect(pen(armed)!.getAttribute('aria-label')).toBe('Annotate mode: click an element or select text to comment. Esc to interact');
    expect(eye(armed)!.querySelector('.sr-only')!.textContent).toBe('Hide tools');
    expect(refresh(armed)!.getAttribute('aria-label')).toBe('Refresh document');
    expect(refresh(armed)!.textContent).toContain('Refresh');

    act(() => root?.unmount());
    const interact = render({ armed: false, toolsHidden: true, isRefreshing: true });
    expect(pen(interact)!.getAttribute('aria-label')).toBe('Interact mode: clicks reach the page (text selection still comments). Click to annotate');
    expect(eye(interact)!.querySelector('.sr-only')!.textContent).toBe('Show tools');
    expect(refresh(interact)!.getAttribute('aria-label')).toBe('Refreshing document');
    expect(refresh(interact)!.textContent).toContain('Refreshing');
    expect(DEFAULT_HTML_SURFACE_CONTROL_LABELS.refreshTitle).toBe('Refresh document');
  });

  test('a label override applies to its key only, and reaches the tooltip and the accessible name', async () => {
    const labels = { hideTools: 'Hide viewer controls', annotateLabel: 'Annotate mode' };
    const el = render({ armed: true, toolsHidden: false, isRefreshing: true, labels });
    // The overridden key reaches the screen-reader text and the tooltip.
    expect(eye(el)!.querySelector('.sr-only')!.textContent).toBe('Hide viewer controls');
    await hover(eye(el)!);
    expect(openTooltipText()).toContain('Hide viewer controls');
    // An explicit aria-label still wins over the description default.
    expect(pen(el)!.getAttribute('aria-label')).toBe('Annotate mode');
    // Keys not overridden keep the defaults.
    expect(refresh(el)!.getAttribute('aria-label')).toBe(DEFAULT_HTML_SURFACE_CONTROL_LABELS.refreshingTitle);
    expect(refresh(el)!.textContent).toContain(DEFAULT_HTML_SURFACE_CONTROL_LABELS.refreshing);
  });

  test('hovering or focusing the eye shows its description and its shortcut, formatted for the platform', async () => {
    const el = render({ toolsHidden: true });
    const binding = htmlAnnotateShortcuts.shortcuts.toggleTools.bindings[0];
    // Formatter-derived, never hardcoded: on a Mac these are glyphs, elsewhere
    // "Ctrl" — a hardcoded string would pass here and lie on half the machines.
    const caps = formatShortcutBindingTokens(binding);

    expect(openTooltipText()).toBeNull();
    await hover(eye(el)!);
    const hovered = openTooltipText();
    expect(hovered).toContain('Show tools');
    for (const cap of caps) expect(hovered!).toContain(cap);

    // Keyboard reaches it too (the whole point of not using `title` alone).
    act(() => root?.unmount());
    const focusEl = render({ toolsHidden: false });
    await focusTrigger(eye(focusEl)!);
    const focused = openTooltipText();
    expect(focused).toContain('Hide tools');
    for (const cap of caps) expect(focused!).toContain(cap);
  });

  test('the pen tooltip names the annotate chord; the refresh has no shortcut row', async () => {
    const el = render({ armed: false });
    const annotateBinding = htmlAnnotateShortcuts.shortcuts.toggleAnnotateMode.bindings[0];
    const annotateCaps = formatShortcutBindingTokens(annotateBinding);

    await hover(pen(el)!);
    const penTip = openTooltipText();
    expect(penTip).toContain('Click to annotate');
    for (const cap of annotateCaps) expect(penTip!).toContain(cap);
    // The shortcut is announced, not only drawn.
    const describedBy = pen(el)!.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent)
      .toContain(formatShortcutBindingText(annotateBinding));

    // Refresh has no chord: no keycaps, and nothing to describe.
    expect(refresh(el)!.hasAttribute('aria-describedby')).toBe(false);
    expect(el.querySelectorAll('kbd').length).toBe(0);
  });
});

describe.if(hasDom)('HtmlSurfaceControls back', () => {
  // The way out of a linked HTML document. An HTML surface opens with the
  // sidebar closed and a link click leaves it closed, so the sidebar's own
  // "Viewing / Back to …" header is not a way back anyone can reach: without
  // this control a reviewer who follows a link is stranded.
  test('renders only with a handler, and is the FIRST control', () => {
    expect(back(render())).toBeNull();

    const el = render({ onBack: () => {} });
    const button = back(el);
    expect(button).not.toBeNull();
    const controls = Array.from(el.querySelectorAll('button'));
    expect(controls[0]).toBe(button!);
  });

  test('clicking it calls the handler', () => {
    let backs = 0;
    const el = render({ onBack: () => { backs += 1; } });
    act(() => { back(el)!.click(); });
    expect(backs).toBe(1);
  });

  test('backDescription names the target and is the accessible name', async () => {
    const el = render({ onBack: () => {}, backDescription: 'Back to index.html' });
    expect(back(el)!.getAttribute('aria-label')).toBe('Back to index.html');
    await hover(back(el)!);
    expect(openTooltipText()).toContain('Back to index.html');
  });

  test('it claims no keyboard shortcut', async () => {
    // Alt+Left and the browser's own Back belong to the user, so the control
    // renders no keycap row and describes no chord.
    const el = render({ onBack: () => {} });
    expect(back(el)!.hasAttribute('aria-describedby')).toBe(false);
    await hover(back(el)!);
    const portal = document.querySelector<HTMLElement>('[data-base-ui-portal]');
    expect(portal?.querySelectorAll('kbd').length ?? 0).toBe(0);
  });

  test('the compact touch shell renders nothing, back included', () => {
    const el = render({ onBack: () => {}, compact: true });
    expect(el.querySelector('button')).toBeNull();
  });
});
