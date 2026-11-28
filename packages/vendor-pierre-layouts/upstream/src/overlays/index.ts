import { PANE_VISIBILITY_EVENT } from '../dom/panes';

/**
 * Overlays over a layout: a modal over the workspace and a drawer that slides
 * in from an edge of it. Each overlay renders in the top layer, so that no
 * pane, transform, or clip of the layout can hide it, and it takes its
 * position from the box of the layout root.
 *
 * An overlay hides the panes that it covers completely. Their hosts get
 * `data-overlay-covered` (`content-visibility: hidden` in `overlays.css`) and
 * `inert` in one style update, so their content skips style, layout, and
 * paint while the overlay is open, as the panes under a zoomed pane do. Each
 * change of cover goes to the app as `OVERLAY_COVER_EVENT` on the layout root:
 * a native view in a pane, such as an Electron view, paints over DOM overlays,
 * and only the app can move it.
 *
 * This module imports nothing from the store or the geometry, so an app loads
 * it only when it imports overlays.
 */

export type OverlayEdge = 'left' | 'right' | 'top' | 'bottom';

/**
 * How a modal keeps the user in it. Experimental, for the comparison of
 * `explore-overlays-boundary`:
 *
 * - `popover` (the default): a `manual` popover with `role="dialog"`,
 *   `aria-modal`, and a focus trap. Each element outside it gets
 *   `aria-hidden`, which takes the page out of the accessibility tree with no
 *   new style, and its backdrop takes the pointer. The covered panes stop
 *   rendering. Nothing becomes inert: a script can still focus an element in
 *   a pane, and the browser's find in page still finds its text.
 * - `dialog-hide-covered`: the panes that the modal covers stop rendering
 *   first, then `showModal()`. The browser makes the page inert, and Chromium
 *   then gives each element that renders a new style: about 280 ms at 16
 *   panes of real content, at the open and again at the close.
 * - `dialog`: `showModal()` with every pane rendering, the reference.
 *
 * A `<dialog>` closes with no exit animation (see `closesAtOnce`).
 */
export type ModalStrategy = 'dialog' | 'dialog-hide-covered' | 'popover';

/** The panes under an overlay. */
export interface OverlayCover {
  /** Panes inside the overlay's box. */
  readonly covered: readonly string[];
  /** Panes that the overlay's box crosses: they show in part. */
  readonly overlapped: readonly string[];
}

/**
 * The event that the layout root receives when the panes under an overlay
 * change: when it opens, when the workspace changes size, and when it starts
 * to close (with no panes).
 */
export const OVERLAY_COVER_EVENT = 'pierre-layout-cover';
export type OverlayCoverEvent = CustomEvent<
  OverlayCover & { overlay: HTMLElement }
>;

/** An overlay that the app opens and closes. */
export interface OverlayHandle {
  /** True from `open()` until the overlay leaves the top layer. */
  readonly isOpen: boolean;
  open(): void;
  /** Close with the exit animation. `onClose` runs at the start. */
  close(): void;
  /** Close at once and remove the listeners. */
  destroy(): void;
}

interface OverlayOptions {
  /** The layout root (`.pierre-layout`), or an element that contains it. */
  layout: HTMLElement;
  /**
   * Called when the overlay starts to close: by Escape, or by `close()`. Set
   * the app's state here.
   */
  onClose?: () => void;
  /** Called with each change of the panes under the overlay. */
  onCover?: (cover: OverlayCover) => void;
}

export interface ModalOptions extends OverlayOptions {
  /**
   * `translucent` (the default) dims the page around the modal, and the panes
   * outside the modal's box stay visible. `opaque` hides the page, so no pane
   * renders while the modal is open.
   */
  backdrop?: 'translucent' | 'opaque';
  /** See `ModalStrategy`. The element is a `<dialog>` unless this is `popover`. */
  strategy?: ModalStrategy;
}

export interface DrawerOptions extends OverlayOptions {
  /** The edge of the workspace that the drawer slides in from. */
  edge: OverlayEdge;
  /**
   * The button that opens the drawer. It gets `aria-expanded`, and the focus
   * returns to it when the drawer closes. Put the drawer right after it in the
   * DOM, so that the Tab order goes from the button into the drawer.
   */
  trigger?: HTMLElement | null;
}

interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * Sort panes into the ones inside an overlay's box and the ones that cross
 * it. Half a pixel of tolerance absorbs the rounding of fractional boxes.
 */
export function coverOf(
  panes: readonly { id: string; box: Box }[],
  box: Box
): OverlayCover {
  const covered: string[] = [];
  const overlapped: string[] = [];
  const slack = 0.5;
  for (const { id, box: pane } of panes) {
    const inside =
      pane.left >= box.left - slack &&
      pane.top >= box.top - slack &&
      pane.right <= box.right + slack &&
      pane.bottom <= box.bottom + slack;
    const crosses =
      pane.left < box.right - slack &&
      pane.right > box.left + slack &&
      pane.top < box.bottom - slack &&
      pane.bottom > box.top + slack;
    if (inside) covered.push(id);
    else if (crosses) overlapped.push(id);
  }
  return { covered, overlapped };
}

const NO_COVER: OverlayCover = { covered: [], overlapped: [] };
const ANIMATION_ID = 'pierre-layout-overlay';
const DEFAULT_DURATION_MS = 240;
// The ease-out curve of the layout's own animations, as cubic-bezier: Safari
// runs `linear()` easing on the main thread.
const EASING = 'cubic-bezier(0.2, 0, 0, 1)';
// Elements that take the focus with Tab, for the focus of a popover modal.
const TABBABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])';

/** The layout root: the element itself, or the first `.pierre-layout` inside it. */
function layoutRootOf(element: HTMLElement): HTMLElement {
  if (element.classList.contains('pierre-layout')) return element;
  return element.querySelector<HTMLElement>('.pierre-layout') ?? element;
}

/** The pane hosts: children of the root, so no query walks pane content. */
function paneHostsOf(root: HTMLElement): HTMLElement[] {
  return Array.from(root.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.dataset.layoutPane !== undefined
  );
}

const paneIdOf = (host: HTMLElement): string => host.dataset.layoutPane ?? '';

// A pane host that renders apart from overlays. A hidden pane or a tab that
// does not show (`data-pane-hidden`) and a pane under a zoom (`data-hidden`)
// keep their own `inert`, and an overlay does not change their state. A
// collapsed pane renders its header, so an overlay can cover it.
const rendersAlready = (host: HTMLElement): boolean =>
  host.dataset.paneHidden !== 'true' && host.dataset.hidden !== 'true';

// The overlays that hide each pane host. A host shows again when the last of
// them stops hiding it.
const coveringOverlays = new WeakMap<HTMLElement, Set<object>>();

function notify(host: HTMLElement, hidden: boolean): void {
  host.dispatchEvent(
    new CustomEvent(PANE_VISIBILITY_EVENT, { detail: { hidden } })
  );
}

/**
 * Stop a pane host from rendering for an overlay. `inert` changes in the same
 * style update as `content-visibility`, so the content gets no new style for
 * either change.
 */
function coverHost(host: HTMLElement, overlay: object): void {
  const overlays = coveringOverlays.get(host) ?? new Set();
  coveringOverlays.set(host, overlays);
  if (overlays.has(overlay)) return;
  overlays.add(overlay);
  if (overlays.size > 1) return;
  host.dataset.overlayCovered = 'true';
  host.inert = true;
  notify(host, true);
}

function uncoverHost(host: HTMLElement, overlay: object): void {
  const overlays = coveringOverlays.get(host);
  if (overlays?.delete(overlay) !== true || overlays.size > 0) return;
  delete host.dataset.overlayCovered;
  // A zoom or a hidden pane keeps its own `inert`.
  if (rendersAlready(host)) host.inert = false;
  notify(host, false);
}

function durationOf(root: HTMLElement): number {
  const value = getComputedStyle(root).getPropertyValue('--layout-duration');
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) return DEFAULT_DURATION_MS;
  return value.trim().endsWith('ms') ? parsed : parsed * 1000;
}

function viewportSize(): { width: number; height: number } {
  const { clientWidth, clientHeight } = document.documentElement;
  return { width: clientWidth, height: clientHeight };
}

/**
 * Give an overlay the workspace's box as its containing block: fixed insets
 * from the edges of the viewport. The overlay's own size comes from CSS, and
 * `--layout-workspace-width` and `--layout-workspace-height` let that CSS fill
 * the workspace or stay inside it. These custom properties change on the
 * overlay only, so no pane gets a new style.
 */
function placeOverWorkspace(
  element: HTMLElement,
  workspace: DOMRect,
  edge: OverlayEdge | null
): void {
  const viewport = viewportSize();
  const style = element.style;
  style.top = edge === 'bottom' ? 'auto' : `${workspace.top}px`;
  style.right =
    edge === 'left' ? 'auto' : `${viewport.width - workspace.right}px`;
  style.bottom =
    edge === 'top' ? 'auto' : `${viewport.height - workspace.bottom}px`;
  style.left = edge === 'right' ? 'auto' : `${workspace.left}px`;
  style.setProperty('--layout-workspace-width', `${workspace.width}px`);
  style.setProperty('--layout-workspace-height', `${workspace.height}px`);
}

function tabbablesOf(element: HTMLElement): HTMLElement[] {
  return Array.from(element.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (candidate) => candidate.checkVisibility()
  );
}

/**
 * Focus the `autofocus` element, the first element that takes Tab, or the
 * overlay. The overlay has just shown, so this skips the visibility check of
 * `tabbablesOf`, which would force a style update.
 */
function focusFirst(element: HTMLElement): void {
  const target =
    element.querySelector<HTMLElement>('[autofocus]') ??
    element.querySelector<HTMLElement>(TABBABLE);
  if (target !== null) {
    target.focus();
    return;
  }
  element.tabIndex = -1;
  element.focus();
}

/**
 * Keep the focus in a popover modal: Tab and Shift+Tab wrap inside it, and
 * focus that leaves it by other means comes back. Returns the cleanup.
 */
function trapFocus(element: HTMLElement): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab') return;
    const items = tabbablesOf(element);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  const onFocusIn = (event: FocusEvent): void => {
    if (event.target instanceof Node && !element.contains(event.target))
      focusFirst(element);
  };
  element.addEventListener('keydown', onKeyDown);
  document.addEventListener('focusin', onFocusIn);
  return () => {
    element.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('focusin', onFocusIn);
  };
}

/**
 * Take every element outside an overlay out of the accessibility tree: the
 * siblings of the overlay and of each of its ancestors get `aria-hidden`.
 * Unlike `inert`, an attribute gives no element a new style, unless a style
 * rule selects it. Returns the function that removes the attributes.
 */
function hideOutside(element: HTMLElement): () => void {
  const hidden: Element[] = [];
  for (
    let node: Element = element;
    node.parentElement !== null && node !== document.body;
    node = node.parentElement
  ) {
    for (const sibling of node.parentElement.children) {
      if (
        sibling === node ||
        sibling.hasAttribute('aria-hidden') ||
        sibling instanceof HTMLScriptElement ||
        sibling instanceof HTMLStyleElement
      )
        continue;
      sibling.setAttribute('aria-hidden', 'true');
      hidden.push(sibling);
    }
  }
  return () => {
    for (const sibling of hidden) sibling.removeAttribute('aria-hidden');
  };
}

interface OverlayBehavior {
  /** Put the element in the top layer, and move the focus into it. */
  show(): void;
  /** Take the element out of the top layer. */
  hide(): void;
  /** Undo the effects of `show()` that end when the close starts. */
  release?(): void;
  /** Keyframes of the entry. The exit plays the entry backwards. */
  keyframes: Keyframe[];
  /** The element and the keyframes of a backdrop's entry, if any. */
  backdrop?(): {
    target: Element;
    pseudoElement?: string;
    keyframes: Keyframe[];
  } | null;
  /** Whether the overlay hides every pane: an opaque backdrop. */
  coversAll: boolean;
  /** Whether the panes that the overlay covers stop rendering. */
  hidesCovered: boolean;
  /**
   * Stop all panes from rendering before the overlay shows, and show the ones
   * that it does not cover after the first layout. A modal that makes the
   * page inert needs this, so that the covered content gets no new style.
   */
  hidesAllFirst: boolean;
  /**
   * Leave the top layer when the close starts, with no exit animation. A
   * modal `<dialog>` needs this: while it is modal, the page is inert, and
   * panes that show again during an exit would get a new style twice, once
   * for the inert page and once when it closes. An animation that keeps a
   * closed `<dialog>` in the top layer (`overlay`) runs on the main thread.
   */
  closesAtOnce: boolean;
  /** The inset sides of the overlay: all four, or three for a drawer. */
  edge: OverlayEdge | null;
  /** The element that gets the focus back when the overlay closes. */
  returnFocus(opener: HTMLElement | null): HTMLElement | null;
}

/**
 * The common work of a modal and a drawer: the position over the workspace,
 * the panes under the overlay, the focus, and the animations.
 */
class Overlay {
  private opened = false;
  private root: HTMLElement | null = null;
  private returnFocus: HTMLElement | null = null;
  private observer: ResizeObserver | null = null;
  private cover: OverlayCover = NO_COVER;
  private readonly hidden = new Set<HTMLElement>();
  private entry: Animation[] = [];
  private exit: Animation[] = [];
  private shown = false;
  private duration: number | null = null;

  constructor(
    private readonly element: HTMLElement,
    private readonly options: OverlayOptions,
    private readonly behavior: OverlayBehavior
  ) {}

  get isOpen(): boolean {
    return this.opened;
  }

  open(): void {
    if (this.exit.length > 0) this.finish();
    if (this.opened) return;
    this.opened = true;
    const root = layoutRootOf(this.options.layout);
    this.root = root;
    // Read before the first change: a read after it would force a new style
    // for the whole page when a modal makes it inert.
    this.duration ??= durationOf(root);
    const opener = document.activeElement;
    this.returnFocus = this.behavior.returnFocus(
      opener instanceof HTMLElement && opener !== document.body ? opener : null
    );

    placeOverWorkspace(
      this.element,
      root.getBoundingClientRect(),
      this.behavior.edge
    );
    if (this.behavior.hidesAllFirst)
      for (const host of paneHostsOf(root).filter(rendersAlready))
        this.hide(host);
    this.behavior.show();
    this.shown = true;
    this.entry = this.animate();
    // Read the boxes after the browser lays them out, in the same frame: a
    // read now would force that layout in this task.
    this.observer = new ResizeObserver(() => this.update());
    this.observer.observe(root);
    this.observer.observe(this.element);
  }

  close(): void {
    if (!this.opened || this.exit.length > 0) return;
    this.options.onClose?.();
    this.observer?.disconnect();
    this.observer = null;
    // The panes show again at the start of the exit, so that they render
    // under the closing overlay.
    for (const host of this.hidden) uncoverHost(host, this);
    this.hidden.clear();
    this.report(NO_COVER);
    this.behavior.release?.();
    if (this.behavior.closesAtOnce) this.leaveTopLayer();
    this.restoreFocus();
    // The exit plays the entry backwards from where the entry is, with a new
    // animation: in the bench, Chromium ran an entry that had finished and
    // that `reverse()` turned around on the main thread.
    const entry = this.entry;
    this.entry = [];
    const duration = this.duration ?? DEFAULT_DURATION_MS;
    const elapsed =
      entry.length > 0 ? Number(entry[0].currentTime ?? duration) : duration;
    for (const animation of entry) animation.cancel();
    const exit = this.behavior.closesAtOnce ? [] : this.animate(true);
    for (const animation of exit)
      animation.currentTime = duration - Math.min(elapsed, duration);
    if (exit.length === 0) {
      this.finish();
      return;
    }
    this.exit = exit;
    void Promise.all(exit.map(({ finished }) => finished)).then(
      () => {
        if (this.exit === exit) this.finish();
      },
      () => {
        // A new `open()` cancelled the exit and finished it.
      }
    );
  }

  destroy(): void {
    if (!this.opened) return;
    this.observer?.disconnect();
    this.observer = null;
    for (const host of this.hidden) uncoverHost(host, this);
    this.hidden.clear();
    this.report(NO_COVER);
    this.behavior.release?.();
    this.restoreFocus();
    this.finish();
  }

  /** Report the panes under the overlay, and hide the ones that it covers. */
  private update(): void {
    const root = this.root;
    if (root === null || !this.opened || this.exit.length > 0) return;
    const workspace = root.getBoundingClientRect();
    placeOverWorkspace(this.element, workspace, this.behavior.edge);
    const hosts = paneHostsOf(root).filter(rendersAlready);
    // Offsets ignore the transforms of running animations, so these are the
    // boxes at the end of them.
    const cover = this.behavior.coversAll
      ? { covered: hosts.map(paneIdOf), overlapped: [] }
      : coverOf(
          hosts.map((host) => ({
            id: paneIdOf(host),
            box: {
              left: workspace.left + host.offsetLeft,
              top: workspace.top + host.offsetTop,
              right: workspace.left + host.offsetLeft + host.offsetWidth,
              bottom: workspace.top + host.offsetTop + host.offsetHeight,
            },
          })),
          {
            left: this.element.offsetLeft,
            top: this.element.offsetTop,
            right: this.element.offsetLeft + this.element.offsetWidth,
            bottom: this.element.offsetTop + this.element.offsetHeight,
          }
        );
    if (this.behavior.hidesCovered) {
      const covered = new Set(cover.covered);
      for (const host of hosts) {
        if (covered.has(paneIdOf(host))) this.hide(host);
        else if (this.hidden.delete(host)) uncoverHost(host, this);
      }
    }
    this.report(cover);
  }

  private hide(host: HTMLElement): void {
    this.hidden.add(host);
    coverHost(host, this);
  }

  private leaveTopLayer(): void {
    if (!this.shown) return;
    this.shown = false;
    this.behavior.hide();
  }

  private finish(): void {
    const animations = [...this.entry, ...this.exit];
    this.entry = [];
    this.exit = [];
    for (const animation of animations) animation.cancel();
    this.leaveTopLayer();
    this.opened = false;
  }

  /**
   * Give the focus back to the element that opened the overlay, when the
   * focus is in the overlay or nowhere. This happens when the close starts,
   * so that keys go to the page during the exit. A `<dialog>` may have
   * returned the focus already.
   */
  private restoreFocus(): void {
    const target = this.returnFocus;
    this.returnFocus = null;
    const active = document.activeElement;
    const lost =
      active === null ||
      active === document.body ||
      this.element.contains(active);
    if (lost && target?.isConnected === true)
      target.focus({ preventScroll: true });
  }

  /**
   * Play the entry of the overlay and its backdrop, or the exit backwards,
   * with transforms and opacity.
   */
  private animate(backwards = false): Animation[] {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return [];
    const timing: KeyframeAnimationOptions = {
      id: ANIMATION_ID,
      duration: this.duration ?? DEFAULT_DURATION_MS,
      easing: EASING,
      direction: backwards ? 'reverse' : 'normal',
    };
    const animations = [this.element.animate(this.behavior.keyframes, timing)];
    const backdrop = this.behavior.backdrop?.();
    if (backdrop != null)
      animations.push(
        backdrop.target.animate(backdrop.keyframes, {
          ...timing,
          pseudoElement: backdrop.pseudoElement,
        })
      );
    return animations;
  }

  private report(cover: OverlayCover): void {
    if (sameCover(cover, this.cover)) return;
    this.cover = cover;
    this.options.onCover?.(cover);
    this.root?.dispatchEvent(
      new CustomEvent(OVERLAY_COVER_EVENT, {
        detail: { ...cover, overlay: this.element },
      })
    );
  }
}

function sameCover(a: OverlayCover, b: OverlayCover): boolean {
  const same = (x: readonly string[], y: readonly string[]): boolean =>
    x.length === y.length && x.every((value, index) => value === y[index]);
  return same(a.covered, b.covered) && same(a.overlapped, b.overlapped);
}

function handleOf(overlay: Overlay, cleanup: () => void): OverlayHandle {
  return {
    get isOpen() {
      return overlay.isOpen;
    },
    open: () => overlay.open(),
    close: () => overlay.close(),
    destroy() {
      overlay.destroy();
      cleanup();
    },
  };
}

/** Close an overlay on Escape inside it, unless its content handled the key. */
function closeOnEscape(element: HTMLElement, overlay: Overlay): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      overlay.close();
    }
  };
  element.addEventListener('keydown', onKeyDown);
  return () => element.removeEventListener('keydown', onKeyDown);
}

/**
 * The backdrop of a popover modal: an empty element in the top layer, under
 * the modal. In Chromium, the `::backdrop` of a popover lets the pointer
 * through to the page, so this element takes the pointer, and it keeps the
 * focus where it is on a press.
 */
function createShield(element: HTMLElement, opaque: boolean): HTMLElement {
  const shield = element.ownerDocument.createElement('div');
  shield.className = 'pierre-modal-shield';
  shield.dataset.backdrop = opaque ? 'opaque' : 'translucent';
  shield.popover = 'manual';
  shield.addEventListener('mousedown', (event) => event.preventDefault());
  element.ownerDocument.body.append(shield);
  return shield;
}

/**
 * A modal over the workspace. With a `dialog` strategy, the element is a
 * `<dialog>`: the browser moves the focus into it, keeps the focus there, and
 * makes the rest of the page inert. Escape closes the modal, and the focus
 * returns to the element that had it before the modal opened.
 */
export function createModal(
  element: HTMLElement,
  options: ModalOptions
): OverlayHandle {
  const strategy = options.strategy ?? 'popover';
  const opaque = options.backdrop === 'opaque';
  const dialog =
    strategy === 'popover'
      ? null
      : element instanceof HTMLDialogElement
        ? element
        : null;
  if (strategy !== 'popover' && dialog === null)
    throw new Error('A modal with a dialog strategy needs a <dialog> element');
  element.classList.add('pierre-overlay', 'pierre-modal');
  element.dataset.backdrop = opaque ? 'opaque' : 'translucent';
  if (dialog === null) {
    element.popover = 'manual';
    element.setAttribute('role', 'dialog');
    element.setAttribute('aria-modal', 'true');
  }

  let untrap: (() => void) | null = null;
  let unhide: (() => void) | null = null;
  let shield: HTMLElement | null = null;
  const fade = [{ opacity: 0 }, { opacity: 1 }];
  const overlay = new Overlay(element, options, {
    show() {
      if (dialog !== null) {
        dialog.showModal();
        return;
      }
      shield = createShield(element, opaque);
      shield.showPopover();
      element.showPopover();
      unhide = hideOutside(element);
      focusFirst(element);
      untrap = trapFocus(element);
    },
    hide() {
      if (dialog !== null) {
        dialog.close();
        return;
      }
      element.hidePopover();
      shield?.remove();
      shield = null;
    },
    release() {
      untrap?.();
      unhide?.();
      untrap = null;
      unhide = null;
    },
    keyframes: [
      { opacity: 0, transform: 'scale(0.98)' },
      { opacity: 1, transform: 'none' },
    ],
    backdrop: () =>
      dialog !== null
        ? { target: dialog, pseudoElement: '::backdrop', keyframes: fade }
        : shield !== null
          ? { target: shield, keyframes: fade }
          : null,
    coversAll: opaque,
    // With the `dialog` strategy, every pane keeps rendering: it is the
    // reference for the comparison.
    hidesCovered: strategy !== 'dialog',
    // A popover makes nothing inert, so the covered panes can stop rendering
    // after the first layout, when the modal's box is known.
    hidesAllFirst: strategy === 'dialog-hide-covered',
    closesAtOnce: dialog !== null,
    edge: null,
    returnFocus: (opener) => opener,
  });

  // Escape: a `<dialog>` sends `cancel`, and then closes at once. Close it
  // with the exit animation instead. A popover gets the key itself.
  const onCancel = (event: Event): void => {
    event.preventDefault();
    overlay.close();
  };
  let removeEscape = (): void => {};
  if (dialog !== null) dialog.addEventListener('cancel', onCancel);
  else removeEscape = closeOnEscape(element, overlay);

  return handleOf(overlay, () => {
    dialog?.removeEventListener('cancel', onCancel);
    removeEscape();
  });
}

const DRAWER_FROM: Record<OverlayEdge, string> = {
  left: 'translateX(-100%)',
  right: 'translateX(100%)',
  top: 'translateY(-100%)',
  bottom: 'translateY(100%)',
};

/**
 * A non-modal drawer that slides in from an edge of the workspace, as a
 * `manual` popover. The panes stay usable, except the ones that the drawer
 * covers completely: they stop rendering. The focus moves into the drawer
 * when it opens, and Escape inside it closes it.
 */
export function createDrawer(
  element: HTMLElement,
  options: DrawerOptions
): OverlayHandle {
  const { edge, trigger } = options;
  element.classList.add('pierre-overlay', 'pierre-drawer');
  element.dataset.edge = edge;
  element.popover = 'manual';
  if (!element.hasAttribute('role')) element.setAttribute('role', 'dialog');
  trigger?.setAttribute('aria-expanded', 'false');

  const overlay = new Overlay(element, options, {
    show() {
      element.showPopover();
      trigger?.setAttribute('aria-expanded', 'true');
      focusFirst(element);
    },
    hide: () => element.hidePopover(),
    release: () => trigger?.setAttribute('aria-expanded', 'false'),
    keyframes: [{ transform: DRAWER_FROM[edge] }, { transform: 'none' }],
    coversAll: false,
    hidesCovered: true,
    hidesAllFirst: false,
    closesAtOnce: false,
    edge,
    returnFocus: (opener) => trigger ?? opener,
  });

  return handleOf(overlay, closeOnEscape(element, overlay));
}
