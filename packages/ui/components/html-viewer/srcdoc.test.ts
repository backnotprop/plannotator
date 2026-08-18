/**
 * Rendering-neutrality contract for the HTML viewer (see srcdoc.ts).
 *
 * Arbitrary customer HTML must render exactly as in a plain browser tab: the
 * viewer writes NOTHING into the document's namespace — no bare CSS custom
 * properties (a host `--muted` clobbering an author `--muted` visibly corrupts
 * documents), no `color-scheme`, no root classes, no styling of author
 * elements. Host tokens travel only under the viewer-owned `--pn-*` prefix
 * unless the document opts in via <meta name="plannotator-theme" content="host">.
 *
 * These tests are the mutation guard: reintroducing any bare-token injection
 * for non-opted-in documents must go red here.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { ANNOTATION_HIGHLIGHT_CSS, BRIDGE_SCRIPT } from "./bridge-script";
import {
  DIFF_HIGHLIGHT_CSS,
  buildSrcdocInjection,
  buildThemeTokenPayload,
  hasHostThemeOptIn,
  injectIntoHead,
} from "./srcdoc";

const HOST_TOKENS = {
  "--background": "oklch(0.15 0.02 260)",
  "--muted": "oklch(0.26 0.02 260)",
  "--border": "oklch(0.35 0.02 260)",
  "--destructive": "oklch(0.65 0.20 25)",
  "--focus-highlight": "#4493f8",
};

/** Matches a bare (non --pn-) custom-property declaration like `--muted:`. */
const BARE_TOKEN_DECL = /(^|[^-\w])--(?!pn-)[\w-]+\s*:/m;

describe("buildThemeTokenPayload", () => {
  test("default (arbitrary document): every pushed property is --pn- prefixed", () => {
    const payload = buildThemeTokenPayload(HOST_TOKENS, false);
    expect(Object.keys(payload).length).toBe(Object.keys(HOST_TOKENS).length);
    for (const key of Object.keys(payload)) {
      expect(key.startsWith("--pn-")).toBe(true);
    }
    expect(payload["--pn-muted"]).toBe(HOST_TOKENS["--muted"]);
    expect(payload["--muted"]).toBeUndefined();
  });

  test("host-theme opt-in: bare tokens ride along with the --pn- set", () => {
    const payload = buildThemeTokenPayload(HOST_TOKENS, true);
    expect(payload["--muted"]).toBe(HOST_TOKENS["--muted"]);
    expect(payload["--pn-muted"]).toBe(HOST_TOKENS["--muted"]);
  });
});

describe("buildSrcdocInjection", () => {
  const base = { tokens: HOST_TOKENS, isLight: true, hostTheme: false, diffActive: false };

  test("arbitrary document: no bare custom-property declarations reach the doc", () => {
    const injection = buildSrcdocInjection(base);
    const [themeBlock] = injection.split(ANNOTATION_HIGHLIGHT_CSS);
    expect(themeBlock).toContain("--pn-muted:");
    expect(BARE_TOKEN_DECL.test(themeBlock!.replace(/--pn-[\w-]+\s*:/g, ""))).toBe(false);
  });

  test("arbitrary document: no color-scheme injection in either host theme", () => {
    expect(buildSrcdocInjection({ ...base, isLight: true })).not.toContain("color-scheme");
    expect(buildSrcdocInjection({ ...base, isLight: false })).not.toContain("color-scheme");
  });

  test("host-theme opt-in: bare tokens and symmetric color-scheme are injected", () => {
    const light = buildSrcdocInjection({ ...base, hostTheme: true, isLight: true });
    expect(light).toContain("--muted:");
    expect(light).toContain("color-scheme: light");
    const dark = buildSrcdocInjection({ ...base, hostTheme: true, isLight: false });
    expect(dark).toContain("color-scheme: dark");
  });

  test("diff CSS is absent on plain renders and scoped when active", () => {
    expect(buildSrcdocInjection(base)).not.toContain("plannotator-diff");
    const active = buildSrcdocInjection({ ...base, diffActive: true });
    expect(active).toContain(DIFF_HIGHLIGHT_CSS);
    // Scoped to diff-generated markup only — never bare ins/del selectors that
    // would restyle author elements.
    expect(DIFF_HIGHLIGHT_CSS).toContain("ins.plannotator-diff");
    expect(DIFF_HIGHLIGHT_CSS).toContain("del.plannotator-diff");
    expect(/(^|[}\s;])(ins|del)\s*\{/.test(DIFF_HIGHLIGHT_CSS)).toBe(false);
  });
});

describe("viewer CSS/script namespace", () => {
  test("annotation CSS reads only --pn- variables", () => {
    expect(ANNOTATION_HIGHLIGHT_CSS).toContain("var(--pn-");
    expect(/var\(--(?!pn-)/.test(ANNOTATION_HIGHLIGHT_CSS)).toBe(false);
    expect(ANNOTATION_HIGHLIGHT_CSS).toContain("[data-plannotator-vim-reticle]");
    expect(ANNOTATION_HIGHLIGHT_CSS).toContain("@media (prefers-reduced-motion: reduce)");
    expect(BRIDGE_SCRIPT).toContain("return 'PREVIOUS BLOCK'");
    expect(BRIDGE_SCRIPT).toContain("return 'NEXT BLOCK'");
    expect(BRIDGE_SCRIPT).toContain("return 'SWAPPED ENDS'");
  });

  test("bridge script reads only --pn- variables and guards bare writes", () => {
    expect(/var\(--(?!pn-)/.test(BRIDGE_SCRIPT)).toBe(false);
    // The theme handler's non-opt-in guard: only --pn-* may be set on the root.
    expect(BRIDGE_SCRIPT).toContain("key.indexOf('--pn-') !== 0");
  });
});

describe("hasHostThemeOptIn", () => {
  test("detects the meta tag across attribute order and quoting", () => {
    expect(
      hasHostThemeOptIn('<head><meta name="plannotator-theme" content="host"></head>'),
    ).toBe(true);
    expect(
      hasHostThemeOptIn("<head><meta content='host' name='plannotator-theme'/></head>"),
    ).toBe(true);
    expect(hasHostThemeOptIn("<head><meta name=plannotator-theme content=host></head>")).toBe(
      true,
    );
  });

  test("does not trigger on absent, foreign, or mismatched metas", () => {
    expect(hasHostThemeOptIn("<html><body><p>hi</p></body></html>")).toBe(false);
    expect(hasHostThemeOptIn('<meta name="viewport" content="host">')).toBe(false);
    expect(hasHostThemeOptIn('<meta name="plannotator-theme" content="self">')).toBe(false);
  });
});

// Exercises the real bridge theme handler (the inline-setProperty site): on a
// host theme flip, nothing may land on the author's documentElement except
// --pn-* properties — no bare tokens, no `light` class — unless the document
// opted in to host theming. Requires DOM_TESTS=1 (happy-dom preload).
const hasDom = typeof document !== "undefined";
describe.if(hasDom)("bridge theme handler (DOM)", () => {
  function bridgeMessageData(event: MessageEvent): Record<string, unknown> | null {
    if (!event.data || typeof event.data !== "object") return null;
    return event.data instanceof Object
      ? Object.fromEntries(Object.entries(event.data))
      : null;
  }

  /** The bridge's page MutationObservers, captured at load: callback plus
   * every observe() target. happy-dom stops delivering mutation records once
   * the overlay host holds an SVG marker button (environment bug — see
   * bumpDomGeneration), so observer-scope tests assert the observed target
   * and drive the captured callback with synthetic records directly. */
  const capturedObservers: Array<{
    callback: (mutations: MutationRecord[], observer: MutationObserver) => void;
    targets: Node[];
  }> = [];

  beforeAll(() => {
    const RealMutationObserver = globalThis.MutationObserver;
    (globalThis as unknown as { MutationObserver: unknown }).MutationObserver =
      class CapturingMutationObserver extends RealMutationObserver {
        private readonly entry: { callback: MutationCallback; targets: Node[] };
        constructor(callback: MutationCallback) {
          super(callback);
          this.entry = { callback, targets: [] };
          capturedObservers.push(this.entry as (typeof capturedObservers)[number]);
        }
        override observe(target: Node, options?: MutationObserverInit) {
          this.entry.targets.push(target);
          super.observe(target, options);
        }
      };
    try {
      new Function(BRIDGE_SCRIPT)();
    } finally {
      (globalThis as unknown as { MutationObserver: unknown }).MutationObserver =
        RealMutationObserver;
    }
  });

  /** Deliver synthetic mutation records straight to the bridge's page
   * observer (bypassing happy-dom's broken delivery). */
  function deliverPageMutations(records: Array<Partial<MutationRecord>>) {
    const observer = capturedObservers[0];
    if (!observer) throw new Error("bridge page observer was not captured");
    observer.callback(records as MutationRecord[], null as unknown as MutationObserver);
  }

  function postBridge(data: Record<string, unknown>) {
    window.dispatchEvent(
      new MessageEvent("message", {
        data,
        source: window,
      }),
    );
  }

  /** find-and-mark renders through the rAF-coalesced overlay scheduler (a
   * batch restore renders once instead of once per annotation); happy-dom's
   * requestAnimationFrame is setImmediate-backed, so yielding one macrotask
   * turn (the suite's standard flush) settles the pending overlay render. */
  const flushOverlay = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  /** Failed dead-target searches also carry a wall-clock backoff (300ms
   * doubling to a 5s cap) on top of the generation gate. Tests asserting
   * legitimate recovery after a new generation jump the bridge's monotonic
   * clock (performance.now) past the cap instead of sleeping. */
  let monotonicOffsetMs = 0;
  beforeAll(() => {
    const realNow = performance.now.bind(performance);
    performance.now = () => realNow() + monotonicOffsetMs;
  });
  function advancePastDeadSearchBackoff() {
    monotonicOffsetMs += 6000;
  }

  // --- Annotation overlay helpers -------------------------------------------
  // Committed annotation visuals live in a shadow-rooted overlay host on the
  // root element; nothing annotation-related is written into the page's DOM.

  function overlayHost(): HTMLElement | null {
    return document.querySelector<HTMLElement>("[data-plannotator-overlay-host]");
  }

  function overlayRoot(): ParentNode | null {
    const host = overlayHost();
    if (!host) return null;
    return host.shadowRoot ?? host;
  }

  function allMarkers(): HTMLButtonElement[] {
    const root = overlayRoot();
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLButtonElement>("button[data-plannotator-marker]"));
  }

  function visibleMarkers(): HTMLButtonElement[] {
    return allMarkers().filter((b) => b.style.display !== "none");
  }

  function markersFor(id: string): HTMLButtonElement[] {
    return visibleMarkers().filter((b) => b.getAttribute("data-annotation-id") === id);
  }

  function markerNumber(button: HTMLButtonElement): string {
    return button.querySelector(".pn-marker-num")?.textContent ?? "";
  }

  function visibleHighlights(cls?: string): HTMLElement[] {
    const root = overlayRoot();
    if (!root) return [];
    const selector = cls ? `.pn-hl.${cls}` : ".pn-hl";
    return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
      (el) => el.style.display !== "none",
    );
  }

  /** Committed range targets for one annotation id (cloned), via the
   * bridge's test-only introspection hook. Range EXTENT — which exact text a
   * committed annotation binds — has no other observable in the overlay
   * model (happy-dom lays nothing out, so highlight geometry is all 0x0). */
  function committedRanges(id: string): Range[] {
    const internals = (window as unknown as {
      __plannotatorBridgeInternals?: { committedRanges: (annId: string) => Range[] };
    }).__plannotatorBridgeInternals;
    return internals ? internals.committedRanges(id) : [];
  }

  /** Record every element scrollIntoView lands on across one action. */
  function collectScrollTargets(action: () => void): Element[] {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      action();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
    return scrolled;
  }

  test("author root only receives --pn-* on theme flip; opt-in restores bare push", () => {
    const root = document.documentElement;

    postBridge({
      type: "plannotator-bridge-theme",
      tokens: { "--pn-muted": "red", "--muted": "blue" },
      isLight: true,
      hostTheme: false,
    });
    expect(root.style.getPropertyValue("--pn-muted")).toBe("red");
    expect(root.style.getPropertyValue("--muted")).toBe("");
    expect(root.classList.contains("light")).toBe(false);

    postBridge({
      type: "plannotator-bridge-theme",
      tokens: { "--pn-muted": "red", "--muted": "blue" },
      isLight: true,
      hostTheme: true,
    });
    expect(root.style.getPropertyValue("--muted")).toBe("blue");
    expect(root.classList.contains("light")).toBe(true);

    root.style.removeProperty("--pn-muted");
    root.style.removeProperty("--muted");
    root.classList.remove("light");
  });

  test("Vim navigation is block-first, focus-safe, and posts through the normal selection protocol", async () => {
    document.body.innerHTML = [
      "<h1>Keyboard document</h1>",
      "<p>First paragraph</p>",
      "<p>Second paragraph</p>",
      '<a href="#destination">Native link</a>',
      '<input value="native typing">',
    ].join("");

    postBridge({
      type: "plannotator-bridge-set-input-method",
      method: "pinpoint",
    });
    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });

    const disabledMove = new KeyboardEvent("keydown", {
      key: "j",
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(disabledMove);
    expect(disabledMove.defaultPrevented).toBe(false);
    expect(document.querySelector("[data-plannotator-vim-badge]")).toBeNull();

    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: true,
    });
    postBridge({
      type: "plannotator-bridge-focus-vim",
    });
    expect(document.body.getAttribute("tabindex")).toBe("-1");
    expect(document.body.hasAttribute("data-plannotator-vim-focus-owner")).toBe(true);
    const initial = document.querySelector(".plannotator-pinpoint-hover");
    expect(initial?.textContent).toBe("Keyboard document");
    expect(document.querySelector("[data-plannotator-vim-badge]")?.textContent)
      .toBe("BLOCK · PINPOINT");

    const tab = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(document.querySelector(".plannotator-pinpoint-hover")?.textContent)
      .toBe("Keyboard document");

    const move = new KeyboardEvent("keydown", {
      key: "j",
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(true);
    expect(document.querySelector(".plannotator-pinpoint-hover")?.textContent)
      .toBe("First paragraph");

    const bridgeMessages: Array<Record<string, unknown>> = [];
    const capture = (event: MessageEvent) => {
      const data = bridgeMessageData(event);
      if (data?.type === "plannotator-bridge-selection") bridgeMessages.push(data);
    };
    window.addEventListener("message", capture);
    const comment = new KeyboardEvent("keydown", {
      key: "c",
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(comment);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    window.removeEventListener("message", capture);
    expect(comment.defaultPrevented).toBe(true);
    expect(bridgeMessages.at(-1)).toMatchObject({
      type: "plannotator-bridge-selection",
      text: "First paragraph",
      modeOverride: "comment",
    });

    const input = document.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("Missing bridge input fixture");
    const typing = new KeyboardEvent("keydown", {
      key: "d",
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(typing);
    expect(typing.defaultPrevented).toBe(false);

    const link = document.querySelector<HTMLAnchorElement>("a");
    if (!link) throw new Error("Missing bridge link fixture");
    const activateLink = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    link.dispatchEvent(activateLink);
    expect(activateLink.defaultPrevented).toBe(false);

    postBridge({
      type: "plannotator-bridge-cancel-selection",
    });
    document.body.innerHTML = [
      "<table><tbody>",
      "<tr><td>A1</td><td>A2</td></tr>",
      "<tr><td>B1</td><td>B2</td></tr>",
      "</tbody></table>",
      "<p>After table</p>",
    ].join("");
    postBridge({
      type: "plannotator-bridge-set-input-method",
      method: "pinpoint",
    });
    for (const key of ["l", "l"]) {
      document.body.dispatchEvent(new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      }));
    }
    const a1 = document.querySelector(".plannotator-pinpoint-hover");
    expect(a1?.tagName).toBe("TD");
    expect(a1?.textContent).toBe("A1");
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "j",
      bubbles: true,
      cancelable: true,
    }));
    expect(document.querySelector(".plannotator-pinpoint-hover")?.textContent).toBe("A2");
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "h",
      bubbles: true,
      cancelable: true,
    }));
    expect(document.querySelector(".plannotator-pinpoint-hover")?.tagName).toBe("TR");
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "j",
      bubbles: true,
      cancelable: true,
    }));
    expect(document.querySelector(".plannotator-pinpoint-hover")?.textContent).toBe("B1B2");
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "h",
      bubbles: true,
      cancelable: true,
    }));
    expect(document.querySelector(".plannotator-pinpoint-hover")?.tagName).toBe("TABLE");
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "j",
      bubbles: true,
      cancelable: true,
    }));
    expect(document.querySelector(".plannotator-pinpoint-hover")?.textContent)
      .toBe("After table");

    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });
    document.body.innerHTML = "<p>Alpha <strong>bravo</strong> charlie</p>";
    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: true,
    });
    postBridge({
      type: "plannotator-bridge-focus-vim",
    });
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "l",
      bubbles: true,
      cancelable: true,
    }));
    expect(document.querySelector(".plannotator-pinpoint-hover")?.tagName).toBe("STRONG");
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "v",
      bubbles: true,
      cancelable: true,
    }));
    for (const key of ["w", "e"]) {
      document.body.dispatchEvent(new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      }));
      expect(window.getSelection()?.toString()).toBe("bravo");
    }

    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });
    document.body.innerHTML = "<p>Alpha bravo charlie</p>";
    postBridge({
      type: "plannotator-bridge-set-input-method",
      method: "drag",
    });
    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: true,
    });
    postBridge({
      type: "plannotator-bridge-focus-vim",
    });
    const visual = new KeyboardEvent("keydown", {
      key: "v",
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(visual);
    const word = new KeyboardEvent("keydown", {
      key: "w",
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(word);
    expect(window.getSelection()?.toString()).toBe("Alpha ");
    const action = new KeyboardEvent("keydown", {
      key: " ",
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(action);
    expect(document.querySelector("[data-plannotator-vim-badge]")?.textContent)
      .toBe("ACTION · SELECT");

    postBridge({
      type: "plannotator-bridge-cancel-selection",
    });
    expect(document.querySelector("[data-plannotator-vim-badge]")?.textContent)
      .toBe("VISUAL · SELECT");
    expect(window.getSelection()?.toString()).toBe("Alpha ");

    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });
    document.body.innerHTML = "<p>Collapsed text target</p>";
    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: true,
    });
    postBridge({
      type: "plannotator-bridge-focus-vim",
    });
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "l",
      bubbles: true,
      cancelable: true,
    }));
    const collapsedAction = new KeyboardEvent("keydown", {
      key: "c",
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(collapsedAction);
    expect(collapsedAction.defaultPrevented).toBe(false);
    const collapsedCopy = new KeyboardEvent("keydown", {
      key: "y",
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(collapsedCopy);
    expect(collapsedCopy.defaultPrevented).toBe(false);
    expect(document.querySelector("[data-plannotator-vim-badge]")?.textContent)
      .toBe("NORMAL · SELECT");
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }));
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }));
    const inactiveEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(inactiveEscape);
    expect(inactiveEscape.defaultPrevented).toBe(false);

    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });
    document.body.innerHTML = "<p>Block one</p><p>Block two</p>";
    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: true,
    });
    postBridge({
      type: "plannotator-bridge-focus-vim",
    });
    for (const key of ["V", "j"]) {
      document.body.dispatchEvent(new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      }));
    }
    expect(window.getSelection()?.toString()).toContain("Block two");
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "k",
      bubbles: true,
      cancelable: true,
    }));
    expect(window.getSelection()?.toString()).toBe("Block one");

    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });
    expect(document.body.hasAttribute("tabindex")).toBe(false);
    document.body.replaceChildren();
  });

  test("Vim HUD mode suppresses the iframe badge and emits handled command DTOs", async () => {
    document.body.innerHTML = "<h1>First block</h1><p>Second block</p>";
    const hudMessages: Array<Record<string, unknown>> = [];
    const capture = (event: MessageEvent) => {
      const data = bridgeMessageData(event);
      if (
        data
        && [
          "plannotator-bridge-vim-command",
          "plannotator-bridge-vim-state",
          "plannotator-bridge-vim-help",
        ]
          .includes(typeof data.type === "string" ? data.type : "")
      ) {
        hudMessages.push(data);
      }
    };
    window.addEventListener("message", capture);

    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: true,
      hudEnabled: false,
    });
    postBridge({ type: "plannotator-bridge-focus-vim" });
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "j",
      bubbles: true,
      cancelable: true,
    }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(hudMessages).toEqual([]);
    expect(document.querySelector("[data-plannotator-vim-badge]")).not.toBeNull();

    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });
    document.body.innerHTML = "<h1>First block</h1><p>Second block</p>";
    postBridge({
      type: "plannotator-bridge-set-input-method",
      method: "pinpoint",
    });
    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: true,
      hudEnabled: true,
    });
    postBridge({ type: "plannotator-bridge-focus-vim" });
    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "j",
      bubbles: true,
      cancelable: true,
    }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector("[data-plannotator-vim-badge]")).toBeNull();
    expect(hudMessages).toContainEqual({
      type: "plannotator-bridge-vim-state",
      phase: "block",
    });
    expect(hudMessages).toContainEqual({
      type: "plannotator-bridge-vim-command",
      actionId: "moveDown",
      key: "j",
      context: "block",
    });
    const reticle = document.querySelector<HTMLElement>(
      "[data-plannotator-vim-reticle]",
    );
    expect(reticle).not.toBeNull();
    expect(reticle?.dataset.vimTargetPhase).toBe("block");
    expect(reticle?.dataset.vimTargetLabel).toBe("BLOCK · PARAGRAPH");
    expect(reticle?.querySelectorAll("[data-vim-reticle-corner]")).toHaveLength(4);
    expect(document.querySelector(".plannotator-pinpoint-hover")).toBeNull();

    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "?",
      bubbles: true,
      cancelable: true,
    }));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(hudMessages).toContainEqual({
      type: "plannotator-bridge-vim-help",
      open: true,
    });
    expect(document.querySelector("[data-plannotator-vim-help]")).toBeNull();

    postBridge({
      type: "plannotator-bridge-set-vim-help",
      open: false,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(hudMessages).toContainEqual({
      type: "plannotator-bridge-vim-help",
      open: false,
    });

    document.body.dispatchEvent(new KeyboardEvent("keydown", {
      key: "l",
      bubbles: true,
      cancelable: true,
    }));
    expect(reticle?.dataset.vimTargetPhase).toBe("text");
    expect(reticle?.dataset.vimTargetLabel).toBe("CURSOR · INLINE TEXT");

    for (const key of ["v", "e"]) {
      document.body.dispatchEvent(new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      }));
    }
    expect(reticle?.dataset.vimTargetPhase).toBe("visual");
    expect(reticle?.dataset.vimTargetLabel).toBe("VISUAL · EXACT TOKEN");

    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });
    window.removeEventListener("message", capture);
    document.body.replaceChildren();
  });

  test("routes Vim yank text to the trusted parent without sandbox clipboard access", async () => {
    document.body.innerHTML = "<h1>Keyboard review fixture</h1><p>After</p>";
    const copyMessages: Array<Record<string, unknown>> = [];
    const capture = (event: MessageEvent) => {
      const data = bridgeMessageData(event);
      if (data?.type === "plannotator-bridge-vim-copy") {
        copyMessages.push(data);
      }
    };
    window.addEventListener("message", capture);

    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: true,
      hudEnabled: true,
    });
    postBridge({ type: "plannotator-bridge-focus-vim" });
    for (const key of ["V", "y"]) {
      document.body.dispatchEvent(new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      }));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    window.removeEventListener("message", capture);

    expect(copyMessages).toContainEqual({
      type: "plannotator-bridge-vim-copy",
      text: "Keyboard review fixture",
    });
    const reticle = document.querySelector<HTMLElement>(
      "[data-plannotator-vim-reticle]",
    );
    expect(reticle?.dataset.vimTargetPhase).toBe("block");
    expect(reticle?.dataset.vimTargetLabel).toBe("BLOCK · HEADING");

    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });
    document.body.replaceChildren();
  });

  test("restores the committed Visual range after annotation markup mutates the DOM", () => {
    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });
    document.body.innerHTML = "<p>Alpha bravo charlie</p>";
    postBridge({
      type: "plannotator-bridge-set-input-method",
      method: "drag",
    });
    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: true,
      hudEnabled: false,
    });
    postBridge({ type: "plannotator-bridge-focus-vim" });

    for (const key of ["v", "w", "c"]) {
      document.body.dispatchEvent(new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      }));
    }
    expect(document.querySelector("[data-plannotator-vim-badge]")?.textContent)
      .toBe("ACTION · SELECT");

    postBridge({
      type: "plannotator-bridge-create-mark",
      id: "vim-committed-range",
      annotationType: "comment",
    });

    expect(document.querySelector("[data-plannotator-vim-badge]")?.textContent)
      .toBe("VISUAL · SELECT");
    expect(window.getSelection()?.toString()).toBe("Alpha ");
    // Committed range EXTENT: the record's range binds exactly the visual
    // selection ("Alpha ") — the pre-overlay test verified the inline mark
    // wrapped exactly this text.
    const committedVisualRanges = committedRanges("vim-committed-range");
    expect(committedVisualRanges.length).toBe(1);
    expect(committedVisualRanges[0]!.toString()).toBe("Alpha ");
    // The committed annotation renders as an overlay marker + highlight —
    // never as inline markup inside the page.
    expect(markersFor("vim-committed-range").length).toBe(1);
    expect(
      visibleHighlights("pn-hl-comment").some(
        (el) => el.getAttribute("data-annotation-id") === "vim-committed-range",
      ),
    ).toBe(true);
    expect(document.querySelector("[data-bind-id]")).toBeNull();
    expect(document.querySelector("mark")).toBeNull();

    postBridge({ type: "plannotator-bridge-clear-marks" });
    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });
    document.body.replaceChildren();
  });

  test("restores a whole-block Visual range after annotation markup mutates the DOM", () => {
    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });
    document.body.innerHTML = "<p>Whole block target</p><p>After</p>";
    postBridge({
      type: "plannotator-bridge-set-input-method",
      method: "drag",
    });
    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: true,
      hudEnabled: false,
    });
    postBridge({ type: "plannotator-bridge-focus-vim" });

    for (const key of ["V", "c"]) {
      document.body.dispatchEvent(new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      }));
    }
    expect(document.querySelector("[data-plannotator-vim-badge]")?.textContent)
      .toBe("ACTION · SELECT");

    postBridge({
      type: "plannotator-bridge-create-mark",
      id: "vim-committed-block-range",
      annotationType: "comment",
    });

    expect(document.querySelector("[data-plannotator-vim-badge]")?.textContent)
      .toBe("VISUAL BLOCK · SELECT");
    expect(window.getSelection()?.toString()).toBe("Whole block target");
    // Committed range EXTENT: the whole-block commit binds exactly the
    // block's text, not merely "some range that produced one marker".
    const committedBlockRanges = committedRanges("vim-committed-block-range");
    expect(committedBlockRanges.length).toBe(1);
    expect(committedBlockRanges[0]!.toString()).toBe("Whole block target");
    expect(markersFor("vim-committed-block-range").length).toBe(1);
    expect(document.querySelector("[data-bind-id]")).toBeNull();

    postBridge({ type: "plannotator-bridge-clear-marks" });
    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });
    document.body.replaceChildren();
  });

  test("pinpoint click posts an anchored selection and never mutates the hovered element", async () => {
    document.body.innerHTML = [
      '<div id="hero"><p class="intro">Anchor target text</p><p>Second paragraph</p></div>',
    ].join("");
    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });
    postBridge({
      type: "plannotator-bridge-set-input-method",
      method: "pinpoint",
    });
    // Mode affordance: crosshair cursor attribute while pinpoint is active.
    expect(document.body.hasAttribute("data-plannotator-pinpoint-cursor")).toBe(true);

    const target = document.querySelector<HTMLElement>("p.intro");
    if (!target) throw new Error("target paragraph missing");

    // Hover: the overlay box appears; the page element gains no class/style.
    target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true }));
    const box = document.querySelector<HTMLElement>("[data-plannotator-pinpoint-box]");
    if (!box) throw new Error("pinpoint hover box missing");
    expect(box.style.display).toBe("block");
    expect(target.className).toBe("intro");
    expect(target.getAttribute("style")).toBeNull();

    // Click-to-pin: posts a selection carrying a validated anchor + pinpoint flag.
    // Flush selection posts queued by earlier tests before collecting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const messages: Array<Record<string, unknown>> = [];
    const collect = (event: MessageEvent) => {
      const data = bridgeMessageData(event);
      if (data?.type === "plannotator-bridge-selection") messages.push(data);
    };
    window.addEventListener("message", collect);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    target.dispatchEvent(click);
    // postMessage delivery is task-queued — let it flush before collecting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    window.removeEventListener("message", collect);

    expect(click.defaultPrevented).toBe(true); // page behavior suppressed
    expect(messages.length).toBe(1);
    const posted = messages[0]!;
    expect(posted.pinpoint).toBe(true);
    expect(posted.text).toBe("Anchor target text");
    const anchor = posted.anchor as { selector: string; tagName: string; text?: string };
    expect(anchor.tagName).toBe("p");
    expect(anchor.text).toBe("Anchor target text");
    // The serialized selector must uniquely resolve back to the pinned element.
    const matches = document.querySelectorAll(anchor.selector);
    expect(matches.length).toBe(1);
    expect(matches[0]).toBe(target);

    postBridge({ type: "plannotator-bridge-cancel-selection" });

    // Restoration writes NOTHING into the page: every restore below must
    // leave the author DOM byte-identical.
    const pageSnapshot = document.body.innerHTML;

    // Anchor-first restore: the resolved element owns the placed marker and
    // the scoped text range paints the overlay highlight.
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "pin-restore",
      originalText: "Anchor target text",
      annotationType: "comment",
      anchor,
    });
    await flushOverlay();
    expect(markersFor("pin-restore").length).toBe(1);
    expect(
      visibleHighlights("pn-hl-comment").some(
        (el) => el.getAttribute("data-annotation-id") === "pin-restore",
      ),
    ).toBe(true);
    // Committed range EXTENT: the restored scoped text range binds INSIDE
    // the anchored element and covers exactly the stored text. The scroll
    // proxy below only checks the ELEMENT target — without this, the range
    // could bind anywhere in the document and still pass.
    const restoredRanges = committedRanges("pin-restore");
    expect(restoredRanges.length).toBe(1);
    expect(restoredRanges[0]!.toString()).toBe("Anchor target text");
    expect(target.contains(restoredRanges[0]!.startContainer)).toBe(true);
    expect(target.contains(restoredRanges[0]!.endContainer)).toBe(true);
    // Scrolling the annotation lands on the anchored element itself.
    const anchoredScroll = collectScrollTargets(() => {
      postBridge({ type: "plannotator-bridge-scroll-to", id: "pin-restore" });
    });
    expect(anchoredScroll[0]).toBe(target);
    expect(document.body.innerHTML).toBe(pageSnapshot);
    postBridge({ type: "plannotator-bridge-remove-mark", id: "pin-restore" });
    expect(markersFor("pin-restore").length).toBe(0);

    // Text drift under a STABLE anchor (#id): the element still identifies
    // itself, so when the text is gone everywhere it gets a placed marker
    // (still counts as restored).
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "pin-badge",
      originalText: "Text that no longer exists anywhere",
      annotationType: "comment",
      anchor: { selector: "#hero", tagName: "div" },
    });
    await flushOverlay();
    const driftMarkers = markersFor("pin-badge");
    expect(driftMarkers.length).toBe(1);
    expect(markerNumber(driftMarkers[0]!)).toBe("1");
    expect(driftMarkers[0]!.getAttribute("aria-label")).toBe("Comment 1");
    expect(driftMarkers[0]!.tagName).toBe("BUTTON");
    expect(document.body.innerHTML).toBe(pageSnapshot);

    // A weak anchor with NO text snapshot is rejected outright (a missing
    // snapshot is a rejection, not an exemption): restoration falls back to
    // the document-wide text search instead of trusting the element.
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "pin-no-snapshot",
      originalText: "Second paragraph",
      annotationType: "comment",
      anchor: { selector: anchor.selector, tagName: "p" },
    });
    await flushOverlay();
    expect(markersFor("pin-no-snapshot").length).toBe(1);
    const fallbackScroll = collectScrollTargets(() => {
      postBridge({ type: "plannotator-bridge-scroll-to", id: "pin-no-snapshot" });
    });
    // The text was found in the SECOND paragraph, not the anchored element.
    expect(fallbackScroll[0]?.textContent).toBe("Second paragraph");
    expect(fallbackScroll[0]).not.toBe(target);
    postBridge({ type: "plannotator-bridge-remove-mark", id: "pin-no-snapshot" });

    // Fail-closed anchors: a weak selector whose text snapshot no longer
    // matches must not resolve (falls back to document-wide text search).
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "pin-stale",
      originalText: "Second paragraph",
      annotationType: "comment",
      anchor: { selector: anchor.selector, tagName: "p", text: "Stale snapshot" },
    });
    await flushOverlay();
    expect(markersFor("pin-stale").length).toBe(1);
    const staleScroll = collectScrollTargets(() => {
      postBridge({ type: "plannotator-bridge-scroll-to", id: "pin-stale" });
    });
    expect(staleScroll[0]?.textContent).toBe("Second paragraph");
    expect(staleScroll[0]).not.toBe(target);
    expect(document.body.innerHTML).toBe(pageSnapshot);

    postBridge({ type: "plannotator-bridge-clear-marks" });
    expect(visibleMarkers().length).toBe(0);
    postBridge({
      type: "plannotator-bridge-set-input-method",
      method: "drag",
    });
    expect(document.body.hasAttribute("data-plannotator-pinpoint-cursor")).toBe(false);
    document.body.replaceChildren();
  });

  test("deeply nested targets get no anchor instead of a quadratic selector walk", async () => {
    // Each ancestor step costs a document-wide uniqueness query against a
    // growing selector, so unbounded depth freezes the tab on one click
    // (measured ~58s at depth 800 pre-cap). Past MAX_ANCHOR_PATH_DEPTH the
    // anchor is abandoned and restoration falls back to text search.
    // Two structurally identical chains: every positional selector along the
    // walk matches both branches, so uniqueness cannot short-circuit before
    // the depth cap fires (the branch point sits above it).
    const DEPTH = 60;
    let chainA = "<p>Deeply buried text</p>";
    let chainB = "<p>Other branch text</p>";
    for (let i = 0; i < DEPTH; i++) {
      chainA = `<div>${chainA}</div>`;
      chainB = `<div>${chainB}</div>`;
    }
    document.body.innerHTML = chainA + chainB;
    const target = document.querySelector<HTMLElement>("p");
    if (!target || target.textContent !== "Deeply buried text") throw new Error("deep target missing");
    postBridge({ type: "plannotator-bridge-set-input-method", method: "pinpoint" });

    const messages: Array<Record<string, unknown>> = [];
    const collect = (event: MessageEvent) => {
      const data = bridgeMessageData(event);
      if (data?.type === "plannotator-bridge-selection") messages.push(data);
    };
    window.addEventListener("message", collect);
    const started = performance.now();
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const elapsed = performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 0));
    window.removeEventListener("message", collect);

    expect(messages.length).toBe(1);
    expect(messages[0]!.text).toBe("Deeply buried text");
    expect((messages[0] as { anchor?: unknown }).anchor).toBeUndefined();
    // Bounded work: the capped walk must complete in interactive time even
    // under happy-dom's slow selector engine.
    expect(elapsed).toBeLessThan(2000);

    postBridge({ type: "plannotator-bridge-cancel-selection" });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  test("behavioral-attribute anchors never bypass the text check", async () => {
    // Regenerated page: the button kept its role but its meaning flipped; the
    // annotated text moved into a sibling paragraph. The role anchor must NOT
    // resolve (role names behavior, not content) — the annotation follows the
    // text via the document-wide search, and no pin lands on the button.
    document.body.innerHTML = [
      '<button role="button">Delete everything</button>',
      "<p>Save draft</p>",
    ].join("");
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "role-anchor",
      originalText: "Save draft",
      annotationType: "comment",
      anchor: { selector: 'button[role="button"]', tagName: "button", text: "Save draft" },
    });
    await flushOverlay();
    expect(markersFor("role-anchor").length).toBe(1);
    const roleScroll = collectScrollTargets(() => {
      postBridge({ type: "plannotator-bridge-scroll-to", id: "role-anchor" });
    });
    // The annotation followed the TEXT into the paragraph — never the button.
    expect(roleScroll[0]?.tagName).toBe("P");
    postBridge({ type: "plannotator-bridge-clear-marks" });

    // data-* attributes ARE author-controlled identity: a data-testid anchor
    // whose text drifted still resolves, and with the text gone everywhere the
    // element gets the placed marker.
    document.body.innerHTML = '<div data-testid="stats">New numbers</div>';
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "data-anchor",
      originalText: "Old numbers",
      annotationType: "comment",
      anchor: { selector: 'div[data-testid="stats"]', tagName: "div", text: "Old numbers" },
    });
    await flushOverlay();
    expect(markersFor("data-anchor").length).toBe(1);
    const dataScroll = collectScrollTargets(() => {
      postBridge({ type: "plannotator-bridge-scroll-to", id: "data-anchor" });
    });
    expect(dataScroll[0]).toBe(document.querySelector('div[data-testid="stats"]'));
    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("data-test-id/data-cy/data-qa are author-controlled identity attrs", async () => {
    // Same trust class as data-testid: the anchor resolves without a text
    // check even after the element's content drifted completely.
    document.body.innerHTML = '<div data-cy="metrics">Fresh content</div>';
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "cy-anchor",
      originalText: "Stale content gone from the page",
      annotationType: "comment",
      anchor: { selector: 'div[data-cy="metrics"]', tagName: "div", text: "Stale content gone from the page" },
    });
    await flushOverlay();
    expect(markersFor("cy-anchor").length).toBe(1);
    expect(document.querySelector("[data-bind-id]")).toBeNull();
    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  // --- New hit-testing contract: hover targets the real element under the
  // cursor (no tag whitelist, no has-text requirement). happy-dom has no
  // layout, so document.elementFromPoint yields nothing and resolution runs
  // from the event target — which in a real browser IS the deepest rendered
  // element under the pointer, the exact geometry these tests model.

  /** Signoff-page-shaped fixture: styled div/span chips, buttons, cards. */
  const SIGNOFF_MARKUP = [
    "<section><div class=\"frame\">",
    "<div class=\"ihead\"><span class=\"dnum\">R1</span>",
    "<span class=\"ibehav\">Empty library state</span></div>",
    "<div class=\"rline\"><span class=\"rkey\">no-jargon</span>",
    "<span class=\"rowchip\">adopted by 1</span></div>",
    "<span class=\"btn primary\">Create</span>",
    "</div></section>",
  ].join("");

  function hoverAt(el: Element, x: number, y: number) {
    el.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    }));
  }

  async function clickAndCollectSelection(el: Element, x: number, y: number) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const messages: Array<Record<string, unknown>> = [];
    const collect = (event: MessageEvent) => {
      const data = bridgeMessageData(event);
      if (data?.type === "plannotator-bridge-selection") messages.push(data);
    };
    window.addEventListener("message", collect);
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    });
    el.dispatchEvent(click);
    await new Promise((resolve) => setTimeout(resolve, 0));
    window.removeEventListener("message", collect);
    return { click, messages };
  }

  test("chips and small buttons on div/span markup are individually targetable", async () => {
    document.body.innerHTML = SIGNOFF_MARKUP;
    postBridge({ type: "plannotator-bridge-set-vim-mode", enabled: false });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "pinpoint" });

    const chip = document.querySelector<HTMLElement>("span.rowchip");
    if (!chip) throw new Error("chip fixture missing");

    // Hover resolves the chip itself — not the enclosing section.
    hoverAt(chip, 100, 100);
    const box = document.querySelector<HTMLElement>("[data-plannotator-pinpoint-box]");
    expect(box?.style.display).toBe("block");
    expect(
      document.querySelector<HTMLElement>("[data-plannotator-pinpoint-label]")?.textContent,
    ).toBe("rowchip");
    expect(chip.className).toBe("rowchip"); // page DOM untouched

    const { click, messages } = await clickAndCollectSelection(chip, 100, 100);
    expect(click.defaultPrevented).toBe(true);
    expect(messages.length).toBe(1);
    expect(messages[0]!.pinpoint).toBe(true);
    expect(messages[0]!.text).toBe("adopted by 1");
    const chipAnchor = messages[0]!.anchor as { selector: string; tagName: string; text?: string };
    expect(chipAnchor.tagName).toBe("span");
    const chipMatches = document.querySelectorAll(chipAnchor.selector);
    expect(chipMatches.length).toBe(1);
    expect(chipMatches[0]).toBe(chip);
    postBridge({ type: "plannotator-bridge-cancel-selection" });

    // The R1 chip and the small button resolve the same way.
    const dnum = document.querySelector<HTMLElement>("span.dnum");
    if (!dnum) throw new Error("dnum fixture missing");
    hoverAt(dnum, 200, 100);
    expect(
      document.querySelector<HTMLElement>("[data-plannotator-pinpoint-label]")?.textContent,
    ).toBe("dnum");
    const dnumResult = await clickAndCollectSelection(dnum, 200, 100);
    expect(dnumResult.messages.length).toBe(1);
    expect(dnumResult.messages[0]!.text).toBe("R1");
    postBridge({ type: "plannotator-bridge-cancel-selection" });

    const btn = document.querySelector<HTMLElement>("span.btn");
    if (!btn) throw new Error("button fixture missing");
    hoverAt(btn, 300, 100);
    expect(
      document.querySelector<HTMLElement>("[data-plannotator-pinpoint-label]")?.textContent,
    ).toBe("btn primary");
    const btnResult = await clickAndCollectSelection(btn, 300, 100);
    expect(btnResult.messages.length).toBe(1);
    expect(btnResult.messages[0]!.text).toBe("Create");

    postBridge({ type: "plannotator-bridge-cancel-selection" });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  test("pointing at a container's uncovered area selects the container", async () => {
    // The geometric scope rule (matches the markdown surface): the deepest
    // element under the pointer wins, so a pointer over the card's padding —
    // where the card itself is the deepest rendered element — selects the
    // card, no keyboard or cycling involved.
    document.body.innerHTML = SIGNOFF_MARKUP;
    postBridge({ type: "plannotator-bridge-set-vim-mode", enabled: false });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "pinpoint" });

    const frame = document.querySelector<HTMLElement>("div.frame");
    if (!frame) throw new Error("frame fixture missing");
    hoverAt(frame, 400, 150);
    expect(
      document.querySelector<HTMLElement>("[data-plannotator-pinpoint-label]")?.textContent,
    ).toBe("frame");
    const { messages } = await clickAndCollectSelection(frame, 400, 150);
    expect(messages.length).toBe(1);
    expect((messages[0]!.anchor as { tagName: string }).tagName).toBe("div");
    expect(String(messages[0]!.text)).toContain("no-jargon");

    postBridge({ type: "plannotator-bridge-cancel-selection" });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  test("tiny elements promote to the nearest ancestor with a >=16px axis", () => {
    document.body.innerHTML = '<div class="card"><span class="dot"></span></div>';
    const card = document.querySelector<HTMLElement>("div.card");
    const dot = document.querySelector<HTMLElement>("span.dot");
    if (!card || !dot) throw new Error("promotion fixture missing");

    const mockRect = (x: number, y: number, width: number, height: number) => ({
      x, y, width, height,
      top: y, left: x, right: x + width, bottom: y + height,
      toJSON: () => ({}),
    }) as DOMRect;
    const originalBodyRect = document.body.getBoundingClientRect;
    document.body.getBoundingClientRect = () => mockRect(0, 0, 800, 600);
    dot.getBoundingClientRect = () => mockRect(10, 10, 8, 8);
    card.getBoundingClientRect = () => mockRect(5, 5, 200, 100);

    try {
      postBridge({ type: "plannotator-bridge-set-vim-mode", enabled: false });
      postBridge({ type: "plannotator-bridge-set-input-method", method: "pinpoint" });
      hoverAt(dot, 12, 12);
      const box = document.querySelector<HTMLElement>("[data-plannotator-pinpoint-box]");
      // The 8x8 dot is under 16px on both axes — the hover box outlines the
      // 200x100 card instead (a floor, not a whitelist).
      expect(box?.style.display).toBe("block");
      expect(box?.style.left).toBe("5px");
      expect(box?.style.width).toBe("200px");
      expect(
        document.querySelector<HTMLElement>("[data-plannotator-pinpoint-label]")?.textContent,
      ).toBe("card");
    } finally {
      document.body.getBoundingClientRect = originalBodyRect;
      postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
      document.body.replaceChildren();
    }
  });

  test("generic-container labels follow the aria-label/role/class/text cascade", () => {
    document.body.innerHTML = [
      '<div class="stage">',
      '<div id="l-aria" aria-label="Close dialog" class="rowchip">x</div>',
      '<div id="l-role" role="tablist" class="abc12345">x</div>',
      '<div id="l-class" class="styles_Card_a1b2c3">x</div>',
      '<span id="l-text">R9</span>',
      '<div id="l-container"><span>This text is far too long to serve as a hover label for anything</span></div>',
      '<div id="l-long" class="extraverboseclasstokennameone extraverboseclasstokennametwo">x</div>',
      "<p id=\"l-known\">Paragraph text</p>",
      "</div>",
    ].join("");
    postBridge({ type: "plannotator-bridge-set-vim-mode", enabled: false });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "pinpoint" });

    const label = () =>
      document.querySelector<HTMLElement>("[data-plannotator-pinpoint-label]")?.textContent;
    const cases: Array<[string, string]> = [
      ["#l-aria", "Close dialog"], // aria-label beats classes
      ["#l-role", "tablist"], // role beats a hash-looking class
      ["#l-class", "styles Card"], // meaningful tokens, hash token stripped
      ["#l-text", "R9"], // short own text for class-less spans
      ["#l-container", "container"], // nothing meaningful -> container
      // Class-token labels obey the 40-char cap like every other rung.
      ["#l-long", "extraverboseclasstokennameone extraverbo"],
      ["#l-known", "Paragraph"], // known tags keep their names
    ];
    let x = 10;
    for (const [selector, expected] of cases) {
      const el = document.querySelector<HTMLElement>(selector);
      if (!el) throw new Error(`label fixture ${selector} missing`);
      hoverAt(el, (x += 50), 40);
      expect(label()).toBe(expected);
    }

    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  test("text-less elements anchor only through a stable-identity rung", async () => {
    // A text-less element has no snapshot to verify a weak anchor against, so
    // it gets an anchor ONLY when the element itself carries stable identity
    // (#id or an author-controlled data-* identity attribute). It is still
    // annotatable either way — the selection describes the element.
    document.body.innerHTML = [
      '<div class="toolbar">',
      '<span class="icon-close" data-testid="close-btn"></span>',
      '<span class="icon-menu"></span>',
      "<p>Sibling text</p></div>",
    ].join("");
    postBridge({ type: "plannotator-bridge-set-vim-mode", enabled: false });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "pinpoint" });

    const close = document.querySelector<HTMLElement>("span.icon-close");
    if (!close) throw new Error("icon fixture missing");
    hoverAt(close, 60, 60);
    const { click, messages } = await clickAndCollectSelection(close, 60, 60);
    expect(click.defaultPrevented).toBe(true);
    expect(messages.length).toBe(1);
    // No text to quote: the posted selection describes the element.
    expect(messages[0]!.text).toBe("[element: icon close]");
    const anchor = messages[0]!.anchor as { selector: string; tagName: string; text?: string };
    expect(anchor.selector).toBe('span[data-testid="close-btn"]');
    expect(anchor.text).toBe("");
    postBridge({ type: "plannotator-bridge-cancel-selection" });

    // Round trip: the stable-identity anchor resolves without a text check,
    // so the icon gets a placed marker even though text search can never
    // succeed ("[element: icon close]" appears nowhere in the page).
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "identity-pin",
      originalText: "[element: icon close]",
      annotationType: "comment",
      anchor,
    });
    await flushOverlay();
    expect(markersFor("identity-pin").length).toBe(1);
    expect(document.querySelector("[data-bind-id]")).toBeNull();
    postBridge({ type: "plannotator-bridge-clear-marks" });
    expect(visibleMarkers().length).toBe(0);

    // A text-less element with only classes (weak selector) ships NO anchor:
    // there is nothing to verify against, and a wrong-binding anchor is
    // worse than no anchor.
    const menu = document.querySelector<HTMLElement>("span.icon-menu");
    if (!menu) throw new Error("menu icon fixture missing");
    hoverAt(menu, 90, 60);
    const menuResult = await clickAndCollectSelection(menu, 90, 60);
    expect(menuResult.messages.length).toBe(1);
    expect(menuResult.messages[0]!.text).toBe("[element: icon menu]");
    expect(menuResult.messages[0]!.anchor).toBeUndefined();

    postBridge({ type: "plannotator-bridge-cancel-selection" });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  test("identical text-less siblings fail closed instead of rebinding (D1)", async () => {
    // Two structurally identical icons: any structure-derived signature
    // (tag/classes/child count/size) is identical across them, so a
    // positional selector whose sibling was removed would resolve to the
    // WRONG element and still "verify". The contract is therefore: no anchor
    // at all for weak text-less targets, and a crafted positional anchor
    // with no snapshot never resolves.
    document.body.innerHTML = [
      '<div class="strip">',
      '<span class="icon"></span>',
      '<span class="icon"></span>',
      "</div>",
    ].join("");
    postBridge({ type: "plannotator-bridge-set-vim-mode", enabled: false });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "pinpoint" });

    const second = document.querySelectorAll<HTMLElement>("span.icon")[1];
    if (!second) throw new Error("sibling fixture missing");
    hoverAt(second, 120, 60);
    const { messages } = await clickAndCollectSelection(second, 120, 60);
    expect(messages.length).toBe(1);
    expect(messages[0]!.anchor).toBeUndefined();
    postBridge({ type: "plannotator-bridge-cancel-selection" });

    // The old-world failure mode, replayed: after the first icon is removed,
    // span.icon:nth-of-type(2) is gone and span.icon:nth-of-type(1) IS a
    // different element. A crafted positional anchor (empty snapshot) must
    // resolve nothing — no pin, no mark, anywhere.
    second.parentElement!.removeChild(document.querySelectorAll("span.icon")[0]!);
    for (const selector of ["div.strip > span:nth-of-type(2)", "div.strip > span:nth-of-type(1)"]) {
      postBridge({
        type: "plannotator-bridge-find-and-mark",
        id: `rebind-${selector}`,
        originalText: "[element: icon]",
        annotationType: "comment",
        anchor: { selector, tagName: "span", text: "" },
      });
      await flushOverlay();
    }
    expect(visibleMarkers().length).toBe(0);
    expect(document.querySelector("[data-bind-id]")).toBeNull();

    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  test("marker click ownership is identity-gated, not selector-gated (D5)", async () => {
    // A page element spoofing our marker attributes is NOT a viewer overlay:
    // it hovers and annotates like any other element.
    document.body.innerHTML = "<div data-plannotator-marker class=\"fake-marker\">7</div><p id=\"pin-me\">Pinned text</p>";
    postBridge({ type: "plannotator-bridge-set-vim-mode", enabled: false });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "pinpoint" });

    const spoof = document.querySelector<HTMLElement>("div.fake-marker");
    if (!spoof) throw new Error("spoof fixture missing");
    hoverAt(spoof, 40, 40);
    expect(
      document.querySelector<HTMLElement>("[data-plannotator-pinpoint-box]")?.style.display,
    ).toBe("block");
    const { click, messages } = await clickAndCollectSelection(spoof, 40, 40);
    expect(click.defaultPrevented).toBe(true);
    expect(messages.length).toBe(1);
    expect(messages[0]!.text).toBe("7");

    // A REAL placed marker owns its click: it posts mark-click (which the
    // parent maps to focusing the annotation in the panel), not a selection.
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "badge-owner",
      originalText: "Text that exists nowhere on this page",
      annotationType: "comment",
      anchor: { selector: "#pin-me", tagName: "p" },
    });
    await flushOverlay();
    const realMarker = markersFor("badge-owner")[0];
    if (!realMarker) throw new Error("real marker missing");
    const collected: Array<Record<string, unknown>> = [];
    const collect = (event: MessageEvent) => {
      const data = bridgeMessageData(event);
      if (
        data?.type === "plannotator-bridge-selection"
        || data?.type === "plannotator-bridge-mark-click"
      ) collected.push(data);
    };
    window.addEventListener("message", collect);
    realMarker.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    window.removeEventListener("message", collect);
    expect(collected).toEqual([
      { type: "plannotator-bridge-mark-click", id: "badge-owner" },
    ]);

    postBridge({ type: "plannotator-bridge-clear-marks" });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  // --- Shift-click multi-select: several elements, ONE draft comment ---

  const MULTI_MARKUP = [
    '<div id="hero">',
    '<p class="alpha">Alpha text</p>',
    '<p class="beta">Beta text</p>',
    '<p class="gamma">Gamma text</p>',
    "</div>",
  ].join("");

  type BridgeData = Record<string, unknown>;

  /** Collect bridge messages of the given types across one synchronous action. */
  async function collectMessages(
    types: string[],
    action: () => void,
  ): Promise<BridgeData[]> {
    await new Promise((resolve) => setTimeout(resolve, 0)); // flush queued posts
    const messages: BridgeData[] = [];
    const collect = (event: MessageEvent) => {
      const data = bridgeMessageData(event);
      if (data && types.includes(String(data.type))) messages.push(data);
    };
    window.addEventListener("message", collect);
    action();
    await new Promise((resolve) => setTimeout(resolve, 0));
    window.removeEventListener("message", collect);
    return messages;
  }

  function clickAt(el: Element, x: number, y: number, shift: boolean) {
    el.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      shiftKey: shift,
    }));
  }

  function pinnedBoxCount(): number {
    return document.querySelectorAll("[data-plannotator-pinpoint-box][data-pinned]").length;
  }

  async function startMultiDraft(options?: { arm?: boolean }): Promise<{
    primaryKey: string;
    keys: Map<string, string>; // className -> target key
  }> {
    postBridge({ type: "plannotator-bridge-set-vim-mode", enabled: false });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "pinpoint" });
    const alpha = document.querySelector<HTMLElement>("p.alpha")!;
    const selections = await collectMessages(
      ["plannotator-bridge-selection"],
      () => clickAt(alpha, 20, 20, false),
    );
    expect(selections.length).toBe(1);
    expect(selections[0]!.pinpoint).toBe(true);
    expect(typeof selections[0]!.targetKey).toBe("string");
    expect(selections[0]!.targetLabel).toBe("Paragraph");
    const primaryKey = String(selections[0]!.targetKey);
    // The parent arms multi-select only when its comment composer mirrors the
    // draft — replayed here unless the test wants an UNARMED draft.
    if (options?.arm !== false) {
      postBridge({ type: "plannotator-bridge-arm-multi-select", key: primaryKey });
    }
    const keys = new Map<string, string>();
    keys.set("alpha", primaryKey);
    return { primaryKey, keys };
  }

  test("shift-click adds targets to the SAME draft and toggles them off again", async () => {
    document.body.innerHTML = MULTI_MARKUP;
    const { keys } = await startMultiDraft();
    const beta = document.querySelector<HTMLElement>("p.beta")!;
    const gamma = document.querySelector<HTMLElement>("p.gamma")!;

    // Shift-click beta: joins the draft, posts a validated target DTO, and
    // gets its own pinned outline box (primary keeps the main box).
    const added = await collectMessages(
      ["plannotator-bridge-multi-target-added"],
      () => clickAt(beta, 40, 40, true),
    );
    expect(added.length).toBe(1);
    expect(added[0]!.label).toBe("Paragraph");
    expect(added[0]!.text).toBe("Beta text");
    const betaAnchor = added[0]!.anchor as { selector: string };
    const betaMatches = document.querySelectorAll(betaAnchor.selector);
    expect(betaMatches.length).toBe(1);
    expect(betaMatches[0]).toBe(beta);
    keys.set("beta", String(added[0]!.key));
    expect(pinnedBoxCount()).toBe(2);

    const addedGamma = await collectMessages(
      ["plannotator-bridge-multi-target-added"],
      () => clickAt(gamma, 60, 60, true),
    );
    expect(addedGamma.length).toBe(1);
    expect(pinnedBoxCount()).toBe(3);

    // Shift-click beta AGAIN: toggle-off by DOM identity — the removal is
    // echoed to the parent and beta's outline box disappears.
    const removed = await collectMessages(
      ["plannotator-bridge-multi-target-added", "plannotator-bridge-multi-target-removed"],
      () => clickAt(beta, 40, 40, true),
    );
    expect(removed.length).toBe(1);
    expect(removed[0]!.type).toBe("plannotator-bridge-multi-target-removed");
    expect(removed[0]!.key).toBe(keys.get("beta"));
    expect(pinnedBoxCount()).toBe(2);

    postBridge({ type: "plannotator-bridge-cancel-selection" });
    expect(pinnedBoxCount()).toBe(0);
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  test("create-mark commits every draft target under ONE id with ONE badge number", async () => {
    document.body.innerHTML = MULTI_MARKUP;
    await startMultiDraft();
    clickAt(document.querySelector("p.beta")!, 40, 40, true);
    clickAt(document.querySelector("p.gamma")!, 60, 60, true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    postBridge({
      type: "plannotator-bridge-create-mark",
      id: "multi-commit",
      annotationType: "comment",
    });

    // Primary + beta + gamma all render placed markers under the SAME id —
    // and every marker for this grouped annotation shows the SAME number.
    // Numbering derives from the annotation collection, never target count.
    const commitMarkers = markersFor("multi-commit");
    expect(commitMarkers.length).toBeGreaterThanOrEqual(2);
    for (const marker of commitMarkers) {
      expect(markerNumber(marker)).toBe("1");
      expect(marker.getAttribute("aria-label")).toBe("Comment 1");
    }
    expect(pinnedBoxCount()).toBe(0); // draft state fully cleared

    // A SECOND annotation numbers 2 — multi-target markers consumed one slot.
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "second-ann",
      originalText: "Text that exists nowhere on this page",
      annotationType: "comment",
      anchor: { selector: "#hero", tagName: "div" },
    });
    await flushOverlay();
    const numbers = visibleMarkers().map((b) => markerNumber(b));
    expect(numbers).toContain("2");
    expect(numbers.filter((n) => n === "1").length).toBeGreaterThanOrEqual(2);
    expect(numbers.filter((n) => n === "2").length).toBe(1);

    postBridge({ type: "plannotator-bridge-clear-marks" });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  test("removing the primary promotes the next target; removing the last cancels", async () => {
    document.body.innerHTML = MULTI_MARKUP;
    const { primaryKey } = await startMultiDraft();
    const beta = document.querySelector<HTMLElement>("p.beta")!;
    clickAt(beta, 40, 40, true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Shift-click the PRIMARY: it is removed and beta is promoted.
    const removals = await collectMessages(
      ["plannotator-bridge-multi-target-removed"],
      () => clickAt(document.querySelector("p.alpha")!, 20, 20, true),
    );
    expect(removals.length).toBe(1);
    expect(removals[0]!.key).toBe(primaryKey);
    expect(pinnedBoxCount()).toBe(1); // only the promoted primary's main box

    // Committing now marks the PROMOTED element (beta), not alpha.
    postBridge({
      type: "plannotator-bridge-create-mark",
      id: "promoted-commit",
      annotationType: "comment",
    });
    const promotedMarkers = markersFor("promoted-commit");
    expect(promotedMarkers.length).toBe(1);
    const promotedScroll = collectScrollTargets(() => {
      postBridge({ type: "plannotator-bridge-scroll-to", id: "promoted-commit" });
    });
    expect(promotedScroll[0]).toBe(document.querySelector("p.beta"));
    postBridge({ type: "plannotator-bridge-clear-marks" });

    // Fresh draft with ONLY a primary: shift-clicking it cancels the draft —
    // a later create-mark must commit nothing.
    const again = await startMultiDraft();
    const cancel = await collectMessages(
      ["plannotator-bridge-multi-target-removed"],
      () => clickAt(document.querySelector("p.alpha")!, 20, 20, true),
    );
    expect(cancel.length).toBe(1);
    expect(cancel[0]!.key).toBe(again.primaryKey);
    expect(pinnedBoxCount()).toBe(0);
    postBridge({
      type: "plannotator-bridge-create-mark",
      id: "cancelled-commit",
      annotationType: "comment",
    });
    expect(markersFor("cancelled-commit").length).toBe(0);
    expect(visibleMarkers().length).toBe(0);

    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  test("UNARMED pinpoint drafts refuse the shift-toggle (D1: quickLabel-style modes)", async () => {
    // The parent only mirrors targets while the comment composer owns the
    // draft; quickLabel/redline drafts never send arm-multi-select. A
    // shift-click on such a draft must NOT accumulate bridge-side targets the
    // saved annotation would not carry — it behaves as a plain click.
    document.body.innerHTML = MULTI_MARKUP;
    await startMultiDraft({ arm: false });
    const beta = document.querySelector<HTMLElement>("p.beta")!;

    const messages = await collectMessages(
      ["plannotator-bridge-multi-target-added", "plannotator-bridge-selection"],
      () => clickAt(beta, 40, 40, true),
    );
    // No multi-target-added; the shift-click replaced the draft instead.
    expect(messages.length).toBe(1);
    expect(messages[0]!.type).toBe("plannotator-bridge-selection");
    expect(messages[0]!.text).toBe("Beta text");
    expect(pinnedBoxCount()).toBe(1); // only the (new) primary's main box

    // Committing registers nothing beyond the new primary — no orphan pins.
    postBridge({
      type: "plannotator-bridge-create-mark",
      id: "unarmed-commit",
      annotationType: "comment",
    });
    expect(markersFor("unarmed-commit").length).toBeLessThanOrEqual(1);

    postBridge({ type: "plannotator-bridge-clear-marks" });
    postBridge({ type: "plannotator-bridge-cancel-selection" });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  test("a stale or mismatched arm key never arms a draft", async () => {
    document.body.innerHTML = MULTI_MARKUP;
    await startMultiDraft({ arm: false });
    postBridge({ type: "plannotator-bridge-arm-multi-select", key: "not-the-primary" });
    const messages = await collectMessages(
      ["plannotator-bridge-multi-target-added"],
      () => clickAt(document.querySelector("p.beta")!, 40, 40, true),
    );
    expect(messages.length).toBe(0);
    postBridge({ type: "plannotator-bridge-cancel-selection" });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  test("arming is per-draft: a NEW draft after an armed one starts unarmed (D1-R)", async () => {
    // The stale-arm regression: comment-mode draft gets armed, the user
    // switches to a mode the parent does not mirror (quick label posts
    // nothing to the bridge), then starts a NEW draft with a plain click.
    // Without a per-draft reset the old arm leaks into the new draft and the
    // bridge accumulates outlines/pins the saved annotation will not carry.
    document.body.innerHTML = MULTI_MARKUP;
    const { primaryKey } = await startMultiDraft(); // armed comment draft
    postBridge({ type: "plannotator-bridge-arm-multi-select", key: primaryKey });

    // New draft via plain click (no cancel-selection, no re-arm) — exactly
    // what a toolbar mode change followed by a pinpoint click produces.
    const beta = document.querySelector<HTMLElement>("p.beta")!;
    await collectMessages(["plannotator-bridge-selection"], () => clickAt(beta, 40, 40, false));

    // Shift-click on the unarmed new draft must NOT add a target.
    const added = await collectMessages(
      ["plannotator-bridge-multi-target-added"],
      () => clickAt(document.querySelector("p.gamma") ?? document.querySelector("p.alpha")!, 40, 40, true),
    );
    expect(added.length).toBe(0);

    // Committing the new draft registers at most its own primary: no orphans.
    postBridge({
      type: "plannotator-bridge-create-mark",
      id: "stale-arm-commit",
      annotationType: "comment",
    });
    expect(markersFor("stale-arm-commit").length).toBeLessThanOrEqual(1);

    postBridge({ type: "plannotator-bridge-clear-marks" });
    postBridge({ type: "plannotator-bridge-cancel-selection" });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  test("remove-target is idempotent and resyncs a forged primary removal (D4)", async () => {
    document.body.innerHTML = MULTI_MARKUP;
    const { primaryKey } = await startMultiDraft();
    const added = await collectMessages(
      ["plannotator-bridge-multi-target-added"],
      () => clickAt(document.querySelector("p.beta")!, 40, 40, true),
    );
    const betaKey = String(added[0]!.key);
    expect(pinnedBoxCount()).toBe(2);

    // Forged-removal scenario: the parent believed the primary was removed
    // (hostile multi-target-removed) and echoes remove-target back. The
    // bridge, which never removed it, now performs the SAME promotion —
    // both sides converge on beta as the primary.
    postBridge({ type: "plannotator-bridge-remove-target", key: primaryKey });
    expect(pinnedBoxCount()).toBe(1);

    // Idempotency: the same removal again (double echo) is a no-op.
    postBridge({ type: "plannotator-bridge-remove-target", key: primaryKey });
    expect(pinnedBoxCount()).toBe(1);

    // Committing pins the promoted element (beta), matching the parent model.
    postBridge({
      type: "plannotator-bridge-create-mark",
      id: "resync-commit",
      annotationType: "comment",
    });
    expect(markersFor("resync-commit").length).toBe(1);
    postBridge({ type: "plannotator-bridge-clear-marks" });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    void betaKey;
    document.body.replaceChildren();
  });

  test("parent-initiated remove-target mirrors without echoing back", async () => {
    document.body.innerHTML = MULTI_MARKUP;
    await startMultiDraft();
    const added = await collectMessages(
      ["plannotator-bridge-multi-target-added"],
      () => clickAt(document.querySelector("p.beta")!, 40, 40, true),
    );
    const betaKey = String(added[0]!.key);
    expect(pinnedBoxCount()).toBe(2);

    const echoes = await collectMessages(
      ["plannotator-bridge-multi-target-removed"],
      () => postBridge({ type: "plannotator-bridge-remove-target", key: betaKey }),
    );
    expect(echoes.length).toBe(0); // the parent already updated its own list
    expect(pinnedBoxCount()).toBe(1);

    // flash-target on the survivor must not throw or change draft state.
    postBridge({ type: "plannotator-bridge-flash-target", key: betaKey });
    expect(pinnedBoxCount()).toBe(1);

    postBridge({ type: "plannotator-bridge-cancel-selection" });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  test("the multi-target draft is capped at 16 additional targets in the bridge", async () => {
    const paragraphs: string[] = [];
    for (let i = 0; i < 20; i++) paragraphs.push(`<p class="cap-${i}">Cap target ${i}</p>`);
    document.body.innerHTML = `<div id="cap-stage">${paragraphs.join("")}</div>`;
    postBridge({ type: "plannotator-bridge-set-vim-mode", enabled: false });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "pinpoint" });
    const primarySelections = await collectMessages(
      ["plannotator-bridge-selection"],
      () => clickAt(document.querySelector("p.cap-0")!, 10, 10, false), // primary
    );
    postBridge({
      type: "plannotator-bridge-arm-multi-select",
      key: String(primarySelections[0]!.targetKey),
    });

    const added = await collectMessages(
      ["plannotator-bridge-multi-target-added"],
      () => {
        for (let i = 1; i < 20; i++) {
          clickAt(document.querySelector(`p.cap-${i}`)!, 10 + i, 10, true);
        }
      },
    );
    expect(added.length).toBe(16);

    postBridge({ type: "plannotator-bridge-cancel-selection" });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  test("find-and-mark restores additional anchors as same-numbered pins, fail-closed", async () => {
    document.body.innerHTML = MULTI_MARKUP;
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "restore-multi",
      originalText: "Alpha text",
      annotationType: "comment",
      anchor: { selector: "p.alpha", tagName: "p", text: "Alpha text" },
      additionalAnchors: [
        { selector: "p.beta", tagName: "p", text: "Beta text" },
        // Stale snapshot: this anchor must NOT resolve (no pin, no mis-mark).
        { selector: "p.gamma", tagName: "p", text: "Stale snapshot" },
      ],
    });
    await flushOverlay();

    // Primary restored as an anchored element marker + overlay highlight;
    // beta restored as a marker sharing the SAME number; gamma failed closed
    // (stale snapshot resolves nothing — no marker, no mis-highlight).
    const restoreMarkers = markersFor("restore-multi");
    expect(restoreMarkers.length).toBe(2);
    for (const marker of restoreMarkers) expect(markerNumber(marker)).toBe("1");
    expect(
      visibleHighlights("pn-hl-comment").some(
        (el) => el.getAttribute("data-annotation-id") === "restore-multi",
      ),
    ).toBe(true);
    expect(document.querySelector("[data-bind-id]")).toBeNull();

    postBridge({ type: "plannotator-bridge-remove-mark", id: "restore-multi" });
    expect(markersFor("restore-multi").length).toBe(0);
    expect(
      visibleHighlights().some(
        (el) => el.getAttribute("data-annotation-id") === "restore-multi",
      ),
    ).toBe(false);
    document.body.replaceChildren();
  });

  test("hover hit-testing never storms document-wide queries per mousemove", () => {
    // The old hover path rebuilt the semantic target graph (three
    // document-wide querySelectorAll sweeps) on every pointer frame. The new
    // path is per-event hit-testing: element identity plus closest() walks,
    // zero document-wide queries. Graph builds remain click/vim-time only.
    document.body.innerHTML = SIGNOFF_MARKUP;
    postBridge({ type: "plannotator-bridge-set-vim-mode", enabled: false });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "pinpoint" });

    const targets = Array.from(document.querySelectorAll<HTMLElement>("span, div, section"));
    const originalQsa = document.querySelectorAll.bind(document);
    let documentWideQueries = 0;
    (document as { querySelectorAll: typeof document.querySelectorAll }).querySelectorAll = ((
      ...args: Parameters<typeof document.querySelectorAll>
    ) => {
      documentWideQueries += 1;
      return originalQsa(...args);
    }) as typeof document.querySelectorAll;

    try {
      let x = 0;
      for (let i = 0; i < 30; i++) {
        const el = targets[i % targets.length]!;
        hoverAt(el, (x += 23), 90);
      }
      expect(documentWideQueries).toBe(0);
    } finally {
      (document as { querySelectorAll: typeof document.querySelectorAll }).querySelectorAll = originalQsa;
      postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
      document.body.replaceChildren();
    }
  });

  // --- Placed-marker overlay: geometry, lifecycle, and isolation ------------

  const rectOf = (x: number, y: number, width: number, height: number) => ({
    x, y, width, height,
    top: y, left: x, right: x + width, bottom: y + height,
    toJSON: () => ({}),
  }) as DOMRect;

  /** Enable "layout" in happy-dom: give the body a real rect. */
  async function withLayout(run: () => void | Promise<void>) {
    const originalBodyRect = document.body.getBoundingClientRect;
    document.body.getBoundingClientRect = () => rectOf(0, 0, 1024, 768);
    try {
      await run();
    } finally {
      document.body.getBoundingClientRect = originalBodyRect;
    }
  }

  test("annotation overlay is layout-neutral: page DOM untouched, host outside body, pointer-transparent", async () => {
    document.body.innerHTML = [
      '<div id="hero"><p class="intro">Anchor target text</p><p>Second paragraph</p></div>',
    ].join("");
    const pageSnapshot = document.body.innerHTML;

    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "neutral-a",
      originalText: "Anchor target text",
      annotationType: "comment",
      anchor: { selector: "#hero", tagName: "div" },
    });
    await flushOverlay();
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "neutral-b",
      originalText: "Second paragraph",
      annotationType: "deletion",
    });
    await flushOverlay();
    postBridge({
      type: "plannotator-bridge-sync-annotations",
      annotations: [{ id: "neutral-a", number: 1 }, { id: "neutral-b", number: 2 }],
    });
    postBridge({ type: "plannotator-bridge-focus-mark", id: "neutral-b" });
    collectScrollTargets(() => {
      postBridge({ type: "plannotator-bridge-scroll-to", id: "neutral-a" });
    });

    // The author DOM is byte-identical after restore + sync + focus + scroll.
    expect(document.body.innerHTML).toBe(pageSnapshot);
    // Overlay artifacts live OUTSIDE the page's layout, on the root element.
    const host = overlayHost();
    if (!host) throw new Error("overlay host missing");
    expect(host.parentElement).toBe(document.documentElement);
    expect(document.body.contains(host)).toBe(false);
    expect(document.body.querySelector("[data-plannotator-marker]")).toBeNull();
    expect(host.style.position).toBe("fixed");
    expect(host.style.pointerEvents).toBe("none");
    expect(host.style.zIndex).toBe("2147483647");
    // Markers render (numbered, accessible buttons) despite touching nothing.
    expect(markersFor("neutral-a").length).toBe(1);
    expect(markersFor("neutral-b").length).toBe(1);

    postBridge({ type: "plannotator-bridge-focus-mark", id: null });
    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("marker reprojects the stored relative point against fresh geometry (no stored pixels)", async () => {
    document.body.innerHTML = '<div id="geo">Geo target</div>';
    const geo = document.querySelector<HTMLElement>("#geo")!;
    await withLayout(async () => {
      geo.getBoundingClientRect = () => rectOf(100, 50, 200, 100);
      postBridge({
        type: "plannotator-bridge-find-and-mark",
        id: "geo-ann",
        originalText: "Text that exists nowhere on this page",
        annotationType: "comment",
        anchor: { selector: "#geo", tagName: "div", point: { x: 0.25, y: 0.5 } },
      });
      await flushOverlay();
      const first = markersFor("geo-ann");
      expect(first.length).toBe(1);
      expect(first[0]!.style.left).toBe("150px");
      expect(first[0]!.style.top).toBe("100px");

      // The element moves and resizes (responsive rerender): the marker
      // reprojects the NORMALIZED point against the new rect — it never
      // reuses the old pixels.
      geo.getBoundingClientRect = () => rectOf(300, 50, 100, 100);
      postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
      const moved = markersFor("geo-ann");
      expect(moved.length).toBe(1);
      expect(moved[0]!.style.left).toBe("325px");
      expect(moved[0]!.style.top).toBe("100px");
    });
    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("pinpoint click captures the normalized selected point onto the posted anchor", async () => {
    document.body.innerHTML = '<p id="cap">Capture me</p>';
    const cap = document.querySelector<HTMLElement>("#cap")!;
    postBridge({ type: "plannotator-bridge-set-vim-mode", enabled: false });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "pinpoint" });
    const originalBodyRect = document.body.getBoundingClientRect;
    document.body.getBoundingClientRect = () => rectOf(0, 0, 1024, 768);
    cap.getBoundingClientRect = () => rectOf(100, 50, 200, 100);
    try {
      const { messages } = await clickAndCollectSelection(cap, 150, 100);
      expect(messages.length).toBe(1);
      const anchor = messages[0]!.anchor as { point?: { x: number; y: number } };
      expect(anchor.point).toEqual({ x: 0.25, y: 0.5 });

      // Committing places the marker at the captured point's projection.
      postBridge({
        type: "plannotator-bridge-create-mark",
        id: "cap-ann",
        annotationType: "comment",
      });
      const committed = markersFor("cap-ann");
      expect(committed.length).toBe(1);
      expect(committed[0]!.style.left).toBe("150px");
      expect(committed[0]!.style.top).toBe("100px");
    } finally {
      document.body.getBoundingClientRect = originalBodyRect;
    }
    postBridge({ type: "plannotator-bridge-clear-marks" });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.replaceChildren();
  });

  /** Advance the bridge's re-search generation like a real invalidation
   * signal would. Dead-target re-resolution is generation-gated (M3): only
   * text-capable signals (page mutations, settle events, frame loads) unlock
   * it. happy-dom's MutationObserver stops delivering once the overlay host
   * holds an SVG marker (environment bug — real browsers are unaffected), so
   * tests use the settle-event signal, which is synchronous and equivalent. */
  function bumpDomGeneration() {
    document.body.dispatchEvent(new Event("animationend", { bubbles: true }));
  }

  test("unresolved targets omit their markers instead of guessing", async () => {
    document.body.innerHTML = '<div data-testid="vanishing">Now you see me</div>';
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "vanish-ann",
      originalText: "Text that exists nowhere on this page",
      annotationType: "comment",
      anchor: { selector: 'div[data-testid="vanishing"]', tagName: "div" },
    });
    await flushOverlay();
    expect(markersFor("vanish-ann").length).toBe(1);

    // The page rerenders without the element: the anchor no longer resolves,
    // so the marker is omitted — never left floating over unrelated content.
    document.body.innerHTML = "<p>Completely different content</p>";
    bumpDomGeneration();
    postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
    expect(markersFor("vanish-ann").length).toBe(0);
    // The annotation record survives (it stays reachable via the panel), so
    // a page that brings the element back re-resolves and re-renders it
    // (once BOTH a new generation and the failure backoff have passed).
    document.body.innerHTML = '<div data-testid="vanishing">Back again</div>';
    advancePastDeadSearchBackoff();
    bumpDomGeneration();
    postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
    expect(markersFor("vanish-ann").length).toBe(1);

    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("targets scrolled or clipped out of the viewport omit their markers", async () => {
    document.body.innerHTML = '<div id="offscreen">Off screen</div>';
    const el = document.querySelector<HTMLElement>("#offscreen")!;
    await withLayout(async () => {
      el.getBoundingClientRect = () => rectOf(100, -500, 200, 100); // above viewport
      postBridge({
        type: "plannotator-bridge-find-and-mark",
        id: "off-ann",
        originalText: "Text that exists nowhere on this page",
        annotationType: "comment",
        anchor: { selector: "#offscreen", tagName: "div" },
      });
      await flushOverlay();
      expect(markersFor("off-ann").length).toBe(0);

      el.getBoundingClientRect = () => rectOf(100, 2000, 200, 100); // below viewport
      postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
      expect(markersFor("off-ann").length).toBe(0);

      el.getBoundingClientRect = () => rectOf(100, 300, 200, 100); // scrolled back in
      postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
      expect(markersFor("off-ann").length).toBe(1);
    });
    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("edge clamping keeps the full marker reachable; visually detached clamps are omitted", async () => {
    document.body.innerHTML = '<div id="edge">Edge</div><div id="sliver">S</div>';
    const edge = document.querySelector<HTMLElement>("#edge")!;
    const sliver = document.querySelector<HTMLElement>("#sliver")!;
    await withLayout(async () => {
      // A point at the exact left edge clamps to the 29px inset and stays
      // associated with its (40px-wide) target.
      edge.getBoundingClientRect = () => rectOf(0, 40, 40, 40);
      postBridge({
        type: "plannotator-bridge-find-and-mark",
        id: "edge-ann",
        originalText: "Text that exists nowhere on this page",
        annotationType: "comment",
        anchor: { selector: "#edge", tagName: "div", point: { x: 0, y: 0.5 } },
      });
      await flushOverlay();
      const clamped = markersFor("edge-ann");
      expect(clamped.length).toBe(1);
      expect(clamped[0]!.style.left).toBe("29px");
      expect(clamped[0]!.style.top).toBe("60px");

      // A fully visible 4px corner sliver still gets its marker: viewport
      // edges CLAMP, never omit (per the contract only clip-container
      // detachment omits). The raw point (2,4) sits inside the visible rect,
      // so association holds and the 29px inset is rendering-only. The old
      // behavior measured association AFTER clamping, creating a dead band
      // where fully visible edge-flush elements lost their markers.
      sliver.getBoundingClientRect = () => rectOf(0, 2, 4, 4);
      postBridge({
        type: "plannotator-bridge-find-and-mark",
        id: "sliver-ann",
        originalText: "Text that exists nowhere on this page either",
        annotationType: "comment",
        anchor: { selector: "#sliver", tagName: "div" },
      });
      await flushOverlay();
      const sliverMarkers = markersFor("sliver-ann");
      expect(sliverMarkers.length).toBe(1);
      expect(sliverMarkers[0]!.style.left).toBe("29px");
      expect(sliverMarkers[0]!.style.top).toBe("29px");
    });
    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("coincident markers spread horizontally and deterministically", async () => {
    document.body.innerHTML = [
      '<div data-testid="co-a">A</div>',
      '<div data-testid="co-b">B</div>',
    ].join("");
    const a = document.querySelector<HTMLElement>('div[data-testid="co-a"]')!;
    const b = document.querySelector<HTMLElement>('div[data-testid="co-b"]')!;
    await withLayout(async () => {
      a.getBoundingClientRect = () => rectOf(100, 100, 50, 50);
      b.getBoundingClientRect = () => rectOf(100, 100, 50, 50);
      for (const [id, selector] of [["co-1", 'div[data-testid="co-a"]'], ["co-2", 'div[data-testid="co-b"]']] as const) {
        postBridge({
          type: "plannotator-bridge-find-and-mark",
          id,
          originalText: "Text that exists nowhere on this page",
          annotationType: "comment",
          anchor: { selector, tagName: "div" },
        });
        await flushOverlay();
      }
      // Same rounded point (125,125): the group spreads by 12.5px steps,
      // centered on the shared point, ordered by comment number.
      const one = markersFor("co-1");
      const two = markersFor("co-2");
      expect(one.length).toBe(1);
      expect(two.length).toBe(1);
      expect(one[0]!.style.left).toBe("118.75px");
      expect(two[0]!.style.left).toBe("131.25px");
      expect(one[0]!.style.top).toBe("125px");
      expect(two[0]!.style.top).toBe("125px");
      // Deterministic: a re-render yields identical placement.
      postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
      expect(markersFor("co-1")[0]!.style.left).toBe("118.75px");
      expect(markersFor("co-2")[0]!.style.left).toBe("131.25px");
    });
    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("parent-synced numbering overrides registration order and renumbers markers", async () => {
    document.body.innerHTML = [
      '<div data-testid="n-a">A</div>',
      '<div data-testid="n-b">B</div>',
    ].join("");
    for (const [id, selector] of [["n-1", 'div[data-testid="n-a"]'], ["n-2", 'div[data-testid="n-b"]']] as const) {
      postBridge({
        type: "plannotator-bridge-find-and-mark",
        id,
        originalText: "Text that exists nowhere on this page",
        annotationType: "comment",
        anchor: { selector, tagName: "div" },
      });
      await flushOverlay();
    }
    // Pre-sync fallback: registration order.
    expect(markerNumber(markersFor("n-1")[0]!)).toBe("1");
    expect(markerNumber(markersFor("n-2")[0]!)).toBe("2");

    // The parent's ordered collection is authoritative — numbers follow it.
    postBridge({
      type: "plannotator-bridge-sync-annotations",
      annotations: [{ id: "n-2", number: 1 }, { id: "n-1", number: 2 }],
    });
    expect(markerNumber(markersFor("n-2")[0]!)).toBe("1");
    expect(markersFor("n-2")[0]!.getAttribute("aria-label")).toBe("Comment 1");
    expect(markerNumber(markersFor("n-1")[0]!)).toBe("2");
    expect(markersFor("n-1")[0]!.getAttribute("aria-label")).toBe("Comment 2");

    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("malformed sync payloads are ignored or skipped at the bridge boundary", async () => {
    document.body.innerHTML = [
      '<div data-testid="m-a">A</div>',
      '<div data-testid="m-b">B</div>',
    ].join("");
    for (const [id, selector] of [["m-1", 'div[data-testid="m-a"]'], ["m-2", 'div[data-testid="m-b"]']] as const) {
      postBridge({
        type: "plannotator-bridge-find-and-mark",
        id,
        originalText: "Text that exists nowhere on this page",
        annotationType: "comment",
        anchor: { selector, tagName: "div" },
      });
      await flushOverlay();
    }
    postBridge({
      type: "plannotator-bridge-sync-annotations",
      annotations: [{ id: "m-1", number: 5 }, { id: "m-2", number: 6 }],
    });
    expect(markerNumber(markersFor("m-1")[0]!)).toBe("5");

    // A completely malformed list leaves the previous numbering untouched.
    postBridge({ type: "plannotator-bridge-sync-annotations", annotations: 42 });
    postBridge({ type: "plannotator-bridge-sync-annotations" });
    expect(markerNumber(markersFor("m-1")[0]!)).toBe("5");
    expect(markerNumber(markersFor("m-2")[0]!)).toBe("6");

    // Junk entries are skipped; only well-formed (id, integer >= 1) apply.
    postBridge({
      type: "plannotator-bridge-sync-annotations",
      annotations: [
        { id: "m-1", number: 7 },
        { id: "m-2", number: 0 },
        { id: "m-2", number: 2.5 },
        { id: "m-2", number: -3 },
        { id: 5, number: 2 },
        "junk",
        { id: "x".repeat(300), number: 2 },
      ],
    });
    expect(markerNumber(markersFor("m-1")[0]!)).toBe("7");
    // m-2 fell back to registration order (2), not a hostile number.
    expect(markerNumber(markersFor("m-2")[0]!)).toBe("2");

    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("focus highlight covers EVERY rect of a multi-paragraph selection (partial-blue regression)", async () => {
    document.body.innerHTML = "<p>Alpha beta gamma delta</p>";
    const originalGetClientRects = Range.prototype.getClientRects;
    const originalBodyRect = document.body.getBoundingClientRect;
    document.body.getBoundingClientRect = () => rectOf(0, 0, 1024, 768);
    // A wrapped multi-line/multi-paragraph selection yields SEVERAL client
    // rects. The old .focused class landed on querySelector's FIRST inline
    // mark only; the overlay must cover every rect.
    (Range.prototype as unknown as { getClientRects: () => DOMRect[] }).getClientRects = () => [
      rectOf(10, 10, 100, 20),
      rectOf(10, 40, 80, 20),
    ];
    try {
      postBridge({
        type: "plannotator-bridge-find-and-mark",
        id: "focus-multi",
        originalText: "Alpha beta gamma delta",
        annotationType: "comment",
      });
      await flushOverlay();
      // Persistent comment highlight paints both rects.
      const commentRects = visibleHighlights("pn-hl-comment").filter(
        (el) => el.getAttribute("data-annotation-id") === "focus-multi",
      );
      expect(commentRects.length).toBe(2);

      postBridge({ type: "plannotator-bridge-focus-mark", id: "focus-multi" });
      const focusRects = visibleHighlights("pn-hl-focus").filter(
        (el) => el.getAttribute("data-annotation-id") === "focus-multi",
      );
      expect(focusRects.length).toBe(2);
      expect(focusRects.map((el) => el.style.top).sort()).toEqual(["10px", "40px"]);

      postBridge({ type: "plannotator-bridge-focus-mark", id: null });
      expect(visibleHighlights("pn-hl-focus").length).toBe(0);
    } finally {
      (Range.prototype as { getClientRects: typeof originalGetClientRects }).getClientRects =
        originalGetClientRects;
      document.body.getBoundingClientRect = originalBodyRect;
    }
    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("draft selection highlight is overlay-projected and clears on cancel", async () => {
    document.body.innerHTML = "<p>Draft highlight target</p>";
    postBridge({ type: "plannotator-bridge-set-vim-mode", enabled: false });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    const p = document.querySelector("p")!;
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    p.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 25)); // handleSelection debounce

    expect(visibleHighlights("pn-hl-draft").length).toBeGreaterThanOrEqual(1);
    // Draft state never mutates the page.
    expect(document.body.innerHTML).toBe("<p>Draft highlight target</p>");

    postBridge({ type: "plannotator-bridge-cancel-selection" });
    expect(visibleHighlights("pn-hl-draft").length).toBe(0);
    document.body.replaceChildren();
  });

  test("hit-testing for new selections yields placed markers to reach the page beneath", async () => {
    document.body.innerHTML = '<p id="beneath">Beneath text</p><div data-testid="hit">H</div>';
    postBridge({ type: "plannotator-bridge-set-vim-mode", enabled: false });
    // Materialize the overlay host + a marker.
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "hit-ann",
      originalText: "Text that exists nowhere on this page",
      annotationType: "comment",
      anchor: { selector: 'div[data-testid="hit"]', tagName: "div" },
    });
    await flushOverlay();
    const host = overlayHost();
    if (!host) throw new Error("overlay host missing");
    const beneath = document.querySelector<HTMLElement>("#beneath")!;
    const originalElementFromPoint = document.elementFromPoint;
    // Simulate the real browser: the probe lands on the overlay host while
    // markers accept hits, and on the page element once they are yielded.
    (document as { elementFromPoint: typeof document.elementFromPoint }).elementFromPoint = () =>
      host.hasAttribute("data-pn-hittest") ? beneath : host;
    try {
      postBridge({ type: "plannotator-bridge-set-input-method", method: "pinpoint" });
      hoverAt(beneath, 77, 77);
      const label = document.querySelector<HTMLElement>("[data-plannotator-pinpoint-label]");
      expect(label?.style.display).toBe("block");
      expect(label?.textContent).toBe("Paragraph");
      const box = document.querySelector<HTMLElement>("[data-plannotator-pinpoint-box]");
      expect(box?.style.display).toBe("block");
      // The yield is transient: hit-testing restored marker interactivity.
      expect(host.hasAttribute("data-pn-hittest")).toBe(false);
    } finally {
      (document as { elementFromPoint: typeof document.elementFromPoint }).elementFromPoint =
        originalElementFromPoint;
    }
    // String-level guard: happy-dom cannot honor pointer-events, and the
    // elementFromPoint mock above IMPLEMENTS the yield keyed on the
    // data-pn-hittest attribute — a typo in the CSS rule would still pass
    // it. The exact rule must ship in the overlay CSS.
    expect(BRIDGE_SCRIPT).toContain(
      ":host([data-pn-hittest]) .pn-marker, [data-plannotator-overlay-host][data-pn-hittest] .pn-marker { pointer-events: none !important; }",
    );
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  // --- Fix-round regressions: clipping, visibility, search gating, print,
  // --- click-to-select, containment, dedup, numbering, marker anchoring ----

  test("highlight rects are clip-tested against inner scroll containers (M1)", async () => {
    document.body.innerHTML =
      '<div id="scroller"><p id="clipped-p">Clipped highlight text</p></div>';
    const scroller = document.querySelector<HTMLElement>("#scroller")!;
    const clippedP = document.querySelector<HTMLElement>("#clipped-p")!;
    scroller.style.overflow = "hidden";
    const originalGetClientRects = Range.prototype.getClientRects;
    await withLayout(async () => {
      scroller.getBoundingClientRect = () => rectOf(0, 0, 200, 100);
      clippedP.getBoundingClientRect = () => rectOf(0, 50, 200, 120);
      (Range.prototype as unknown as { getClientRects: () => DOMRect[] }).getClientRects = () => [
        rectOf(0, 50, 200, 20), // fully inside the container
        rectOf(0, 90, 200, 20), // straddles the container edge -> trimmed to 10px
        rectOf(0, 150, 200, 20), // fully scrolled past the edge -> dropped
      ];
      try {
        postBridge({
          type: "plannotator-bridge-find-and-mark",
          id: "clip-hl",
          originalText: "Clipped highlight text",
          annotationType: "comment",
        });
        await flushOverlay();
        const painted = visibleHighlights("pn-hl-comment")
          .filter((el) => el.getAttribute("data-annotation-id") === "clip-hl")
          .map((el) => ({ top: el.style.top, height: el.style.height }))
          .sort((a, b) => parseFloat(a.top) - parseFloat(b.top));
        expect(painted).toEqual([
          { top: "50px", height: "20px" },
          { top: "90px", height: "10px" },
        ]);
        // The focus flash paints the same clip-tested rects.
        postBridge({ type: "plannotator-bridge-focus-mark", id: "clip-hl" });
        const focusRects = visibleHighlights("pn-hl-focus").filter(
          (el) => el.getAttribute("data-annotation-id") === "clip-hl",
        );
        expect(focusRects.length).toBe(2);
        postBridge({ type: "plannotator-bridge-focus-mark", id: null });
      } finally {
        (Range.prototype as { getClientRects: typeof originalGetClientRects }).getClientRects =
          originalGetClientRects;
      }
    });
    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("style-hidden targets are unresolved-for-display (M2 visibility gate)", async () => {
    document.body.innerHTML = '<div id="slide">Slide content</div>';
    const slide = document.querySelector<HTMLElement>("#slide")!;
    await withLayout(async () => {
      slide.getBoundingClientRect = () => rectOf(100, 100, 200, 100);
      postBridge({
        type: "plannotator-bridge-find-and-mark",
        id: "vis-ann",
        originalText: "Text that exists nowhere on this page",
        annotationType: "comment",
        anchor: { selector: "#slide", tagName: "div" },
      });
      await flushOverlay();
      expect(markersFor("vis-ann").length).toBe(1);

      // visibility:hidden keeps a full-size rect — the marker must not
      // render over whatever visible content stacks in the same box.
      slide.style.visibility = "hidden";
      postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
      expect(markersFor("vis-ann").length).toBe(0);
      slide.style.visibility = "";

      // opacity:0 deliberately does NOT hide the marker: it is the standard
      // invisible-hit-target pattern (transparent input over a styled
      // control) where the annotation legitimately sits over the visible
      // control — and computed opacity doesn't inherit, so an opacity gate
      // wouldn't catch faded containers' descendants anyway.
      slide.style.opacity = "0";
      postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
      expect(markersFor("vis-ann").length).toBe(1);
      slide.style.opacity = "";

      postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
      expect(markersFor("vis-ann").length).toBe(1);
    });
    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("dead-target re-search is generation-gated, never per-render (M3)", async () => {
    document.body.innerHTML = "<p>Ephemeral searchable text</p>";
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "gen-ann",
      originalText: "Ephemeral searchable text",
      annotationType: "comment",
    });
    await flushOverlay();
    expect(
      visibleHighlights("pn-hl-comment").some(
        (el) => el.getAttribute("data-annotation-id") === "gen-ann",
      ),
    ).toBe(true);

    // The text disappears; the next invalidation triggers ONE failed search.
    document.body.innerHTML = "<p>Different content</p>";
    bumpDomGeneration();
    postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });

    // Repeated renders WITHOUT a new text-capable invalidation must not
    // re-run the whole-document sweep (findTextRange = createTreeWalker).
    const originalCreateTreeWalker = document.createTreeWalker.bind(document);
    let sweeps = 0;
    (document as { createTreeWalker: typeof document.createTreeWalker }).createTreeWalker = ((
      ...args: Parameters<typeof document.createTreeWalker>
    ) => {
      sweeps += 1;
      return originalCreateTreeWalker(...args);
    }) as typeof document.createTreeWalker;
    try {
      for (let i = 0; i < 5; i++) {
        postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
      }
      expect(sweeps).toBe(0);

      // A text-capable invalidation (plus an elapsed failure backoff)
      // unlocks exactly one more search…
      advancePastDeadSearchBackoff();
      bumpDomGeneration();
      postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
      expect(sweeps).toBeGreaterThan(0);
      const afterUnlock = sweeps;
      // …whose failure is cached again for that generation.
      postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
      expect(sweeps).toBe(afterUnlock);
    } finally {
      (document as { createTreeWalker: typeof document.createTreeWalker }).createTreeWalker =
        originalCreateTreeWalker;
    }

    // The text returning re-resolves after the next invalidation (and an
    // elapsed backoff).
    document.body.innerHTML = "<p>Ephemeral searchable text</p>";
    advancePastDeadSearchBackoff();
    bumpDomGeneration();
    postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
    expect(
      visibleHighlights("pn-hl-comment").some(
        (el) => el.getAttribute("data-annotation-id") === "gen-ann",
      ),
    ).toBe(true);

    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("unanchored ids are reported on change: restore failures, late deaths, recovery, and clear", async () => {
    // The fail-closed transparency contract (onUnanchoredChange): the bridge
    // names WHICH annotations currently have no live representation — total
    // restore failures (whose records are removed) and records whose every
    // target died — re-reporting the full set only when it changes.
    const reports: string[][] = [];
    const listener = (e: MessageEvent) => {
      const d = bridgeMessageData(e);
      if (d && d.type === "plannotator-bridge-unanchored") reports.push(d.ids as string[]);
    };
    window.addEventListener("message", listener);
    try {
      document.body.innerHTML = "<p>Anchored copy</p>";
      postBridge({
        type: "plannotator-bridge-find-and-mark",
        id: "live-ann",
        originalText: "Anchored copy",
        annotationType: "comment",
      });
      postBridge({
        type: "plannotator-bridge-find-and-mark",
        id: "ghost-ann",
        originalText: "Text this page never contained",
        annotationType: "comment",
      });
      await flushOverlay();
      // Only the total restore failure reports; the resolved one does not.
      expect(reports.at(-1)).toEqual(["ghost-ann"]);

      // Change-only: an idle re-render must not repeat the report. (Bridge
      // emissions deliver async like all postMessage traffic, so the flush
      // guarantees any duplicate would have arrived before the count check.)
      const countAfterRestore = reports.length;
      postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
      await flushOverlay();
      expect(reports.length).toBe(countAfterRestore);

      // A re-restore that now resolves clears the failed id.
      document.body.innerHTML =
        "<p>Anchored copy</p><p>Text this page never contained</p>";
      postBridge({
        type: "plannotator-bridge-find-and-mark",
        id: "ghost-ann",
        originalText: "Text this page never contained",
        annotationType: "comment",
      });
      await flushOverlay();
      expect(reports.at(-1)).toEqual([]);

      // Late death: both texts vanish, both records go dead after the
      // generation-gated re-search fails.
      document.body.innerHTML = "<p>Unrelated content</p>";
      advancePastDeadSearchBackoff();
      bumpDomGeneration();
      postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
      await flushOverlay();
      expect(reports.at(-1)).toEqual(["ghost-ann", "live-ann"]);

      // Partial recovery: one text returns, the other stays dead.
      document.body.innerHTML = "<p>Anchored copy</p>";
      advancePastDeadSearchBackoff();
      bumpDomGeneration();
      postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
      await flushOverlay();
      expect(reports.at(-1)).toEqual(["ghost-ann"]);

      // clear-marks empties the report along with the records.
      postBridge({ type: "plannotator-bridge-clear-marks" });
      await flushOverlay();
      expect(reports.at(-1)).toEqual([]);
    } finally {
      window.removeEventListener("message", listener);
      postBridge({ type: "plannotator-bridge-clear-marks" });
      document.body.replaceChildren();
    }
  });

  test("mutation-heavy pages: failed re-searches back off on the wall clock and are budgeted per pass (A)", async () => {
    // A page that mutates every frame advances domGeneration every frame, so
    // the generation gate alone would re-run the whole-document sweep per
    // frame forever for permanently unresolvable targets. Failed searches
    // must (1) run at most 2 per reconcile pass and (2) back off on the
    // wall clock even across generation bumps.
    document.body.innerHTML = [0, 1, 2, 3]
      .map((i) => `<p>Backoff text ${i}</p>`)
      .join("");
    for (let i = 0; i < 4; i++) {
      postBridge({
        type: "plannotator-bridge-find-and-mark",
        id: `boff-${i}`,
        originalText: `Backoff text ${i}`,
        annotationType: "comment",
      });
    }
    await flushOverlay();

    // Every target's text disappears: all four ranges are dead.
    document.body.innerHTML = "<p>Rewritten content</p>";

    const originalCreateTreeWalker = document.createTreeWalker.bind(document);
    let sweeps = 0;
    (document as { createTreeWalker: typeof document.createTreeWalker }).createTreeWalker = ((
      ...args: Parameters<typeof document.createTreeWalker>
    ) => {
      sweeps += 1;
      return originalCreateTreeWalker(...args);
    }) as typeof document.createTreeWalker;
    try {
      // Pass 1: only the per-pass budget (2) may search, even though all
      // four targets are eligible.
      bumpDomGeneration();
      postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
      expect(sweeps).toBe(2);
      // The skipped-but-eligible targets get a scheduled follow-up pass.
      await flushOverlay();
      expect(sweeps).toBe(4);
      // No eligible targets remain: no further passes run searches.
      await flushOverlay();
      postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
      expect(sweeps).toBe(4);

      // Mutation-heavy page: generation bumps every "frame". The wall-clock
      // backoff must keep every failed target locked regardless.
      for (let i = 0; i < 5; i++) {
        bumpDomGeneration();
        postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
        await flushOverlay();
      }
      expect(sweeps).toBe(4);

      // Once the backoff elapses AND the generation has advanced, searching
      // resumes (still budgeted per pass).
      advancePastDeadSearchBackoff();
      bumpDomGeneration();
      postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
      expect(sweeps).toBe(6);
      await flushOverlay();
      expect(sweeps).toBe(8);
    } finally {
      (document as { createTreeWalker: typeof document.createTreeWalker }).createTreeWalker =
        originalCreateTreeWalker;
    }

    // A successful search resets the backoff: the text returning re-resolves
    // on the next unlocked pass.
    document.body.innerHTML = [0, 1, 2, 3]
      .map((i) => `<p>Backoff text ${i}</p>`)
      .join("");
    advancePastDeadSearchBackoff();
    bumpDomGeneration();
    postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
    await flushOverlay();
    expect(committedRanges("boff-0").length).toBe(1);
    expect(committedRanges("boff-3").length).toBe(1);

    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("offscreen targets are culled before style/clip reads (B1)", async () => {
    document.body.innerHTML = '<div id="cull-el">Cull element</div><p>Cull range text</p>';
    const el = document.querySelector<HTMLElement>("#cull-el")!;
    await withLayout(async () => {
      // Element target far below the viewport (beyond the cull margin).
      el.getBoundingClientRect = () => rectOf(100, 2000, 200, 100);
      postBridge({
        type: "plannotator-bridge-find-and-mark",
        id: "cull-el-ann",
        originalText: "Text that exists nowhere on this page",
        annotationType: "comment",
        anchor: { selector: "#cull-el", tagName: "div" },
      });
      await flushOverlay();
      expect(markersFor("cull-el-ann").length).toBe(0);

      // A re-render of the culled element does none of the per-target style
      // work (targetStyleHidden / clipBoundsFor both read computed styles).
      const realGetComputedStyle = window.getComputedStyle.bind(window);
      let styleReads = 0;
      (window as { getComputedStyle: typeof window.getComputedStyle }).getComputedStyle = ((
        ...args: Parameters<typeof window.getComputedStyle>
      ) => {
        styleReads += 1;
        return realGetComputedStyle(...args);
      }) as typeof window.getComputedStyle;
      try {
        postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
        expect(markersFor("cull-el-ann").length).toBe(0);
        expect(styleReads).toBe(0);
      } finally {
        (window as { getComputedStyle: typeof window.getComputedStyle }).getComputedStyle =
          realGetComputedStyle;
      }

      // Scrolled back into view, the marker renders again.
      el.getBoundingClientRect = () => rectOf(100, 300, 200, 100);
      postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
      expect(markersFor("cull-el-ann").length).toBe(1);
      postBridge({ type: "plannotator-bridge-remove-mark", id: "cull-el-ann" });

      // Range targets cull on the range's bounding rect BEFORE collecting
      // client rects (the per-rect clip/containment work never runs).
      const originalGetClientRects = Range.prototype.getClientRects;
      const originalRangeBounds = Range.prototype.getBoundingClientRect;
      let rectCollections = 0;
      (Range.prototype as unknown as { getBoundingClientRect: () => DOMRect })
        .getBoundingClientRect = () => rectOf(10, 2000, 100, 20);
      (Range.prototype as unknown as { getClientRects: () => DOMRect[] }).getClientRects = () => {
        rectCollections += 1;
        return [rectOf(10, 2000, 100, 20)];
      };
      try {
        postBridge({
          type: "plannotator-bridge-find-and-mark",
          id: "cull-range-ann",
          originalText: "Cull range text",
          annotationType: "comment",
        });
        await flushOverlay();
        expect(rectCollections).toBe(0);
        expect(
          visibleHighlights("pn-hl-comment").some(
            (hl) => hl.getAttribute("data-annotation-id") === "cull-range-ann",
          ),
        ).toBe(false);
      } finally {
        (Range.prototype as { getClientRects: typeof originalGetClientRects }).getClientRects =
          originalGetClientRects;
        (Range.prototype as { getBoundingClientRect: typeof originalRangeBounds })
          .getBoundingClientRect = originalRangeBounds;
      }
    });
    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("batch restore renders the overlay once, not once per annotation (B3)", async () => {
    document.body.innerHTML =
      '<div id="b3-0">A</div><div id="b3-1">B</div><div id="b3-2">C</div>';
    const counts = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const target = document.querySelector<HTMLElement>(`#b3-${i}`)!;
      const rect = rectOf(50 + i * 100, 100, 50, 50);
      target.getBoundingClientRect = () => {
        counts[i] += 1;
        return rect;
      };
    }
    await withLayout(async () => {
      for (let i = 0; i < 3; i++) {
        postBridge({
          type: "plannotator-bridge-find-and-mark",
          id: `b3-ann-${i}`,
          originalText: "Text that exists nowhere on this page",
          annotationType: "comment",
          anchor: { selector: `#b3-${i}`, tagName: "div" },
        });
      }
      // The projection is deferred: no render (no geometry reads) ran yet.
      expect(counts).toEqual([0, 0, 0]);
      await flushOverlay();
      // ONE coalesced pass rendered the whole batch: each target's geometry
      // was read exactly once (the old synchronous per-restore render read
      // the first target three times: [3, 2, 1]).
      expect(counts).toEqual([1, 1, 1]);
      expect(visibleMarkers().length).toBe(3);
    });
    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("page mutations schedule no reconcile when the overlay has zero work (B4)", async () => {
    postBridge({ type: "plannotator-bridge-clear-marks" });
    postBridge({ type: "plannotator-bridge-cancel-selection" });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    document.body.innerHTML = "<p>B4 idle text</p>";
    await flushOverlay(); // drain anything pending before counting

    const realRaf = window.requestAnimationFrame.bind(window);
    let scheduled = 0;
    (window as { requestAnimationFrame: typeof window.requestAnimationFrame })
      .requestAnimationFrame = ((cb: FrameRequestCallback) => {
        scheduled += 1;
        return realRaf(cb);
      }) as typeof window.requestAnimationFrame;
    try {
      // Zero records, no draft, pinpoint inactive: a page mutation bumps the
      // generation but must not schedule the reconcile frame.
      deliverPageMutations([{
        type: "characterData",
        target: document.body,
      } as Partial<MutationRecord>]);
      expect(scheduled).toBe(0);

      // With a committed record, the same mutation schedules the reconcile.
      postBridge({
        type: "plannotator-bridge-find-and-mark",
        id: "b4-ann",
        originalText: "B4 idle text",
        annotationType: "comment",
      });
      await flushOverlay();
      const before = scheduled;
      deliverPageMutations([{
        type: "characterData",
        target: document.body,
      } as Partial<MutationRecord>]);
      expect(scheduled).toBeGreaterThan(before);
      await flushOverlay();
    } finally {
      (window as { requestAnimationFrame: typeof window.requestAnimationFrame })
        .requestAnimationFrame = realRaf;
    }
    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("hovering a committed highlight brightens its overlay rects without touching the page (D)", async () => {
    document.body.innerHTML = "<p>Hover affordance text</p>";
    const pageSnapshot = document.body.innerHTML;
    const originalGetClientRects = Range.prototype.getClientRects;
    await withLayout(async () => {
      (Range.prototype as unknown as { getClientRects: () => DOMRect[] }).getClientRects = () => [
        rectOf(100, 100, 200, 20),
      ];
      try {
        postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
        postBridge({
          type: "plannotator-bridge-find-and-mark",
          id: "hover-ann",
          originalText: "Hover affordance text",
          annotationType: "comment",
        });
        await flushOverlay();
        const painted = visibleHighlights("pn-hl-comment").filter(
          (hl) => hl.getAttribute("data-annotation-id") === "hover-ann",
        );
        expect(painted.length).toBeGreaterThan(0);
        expect(painted[0]!.classList.contains("pn-hl-hover")).toBe(false);

        // Pointer over the painted rect: the hover class lands on the rect
        // divs inside the shadow root; the page DOM stays byte-identical.
        document.dispatchEvent(new MouseEvent("mousemove", {
          bubbles: true,
          clientX: 150,
          clientY: 110,
        }));
        await flushOverlay();
        expect(painted[0]!.classList.contains("pn-hl-hover")).toBe(true);
        expect(document.body.innerHTML).toBe(pageSnapshot);

        // Pointer off the rect clears the affordance.
        document.dispatchEvent(new MouseEvent("mousemove", {
          bubbles: true,
          clientX: 600,
          clientY: 500,
        }));
        await flushOverlay();
        expect(painted[0]!.classList.contains("pn-hl-hover")).toBe(false);
      } finally {
        (Range.prototype as { getClientRects: typeof originalGetClientRects }).getClientRects =
          originalGetClientRects;
      }
    });
    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("switching to pinpoint before a scheduled hover hit test fires leaves no stale hover (1)", async () => {
    document.body.innerHTML = "<p>Hover race text</p>";
    const originalGetClientRects = Range.prototype.getClientRects;
    await withLayout(async () => {
      (Range.prototype as unknown as { getClientRects: () => DOMRect[] }).getClientRects = () => [
        rectOf(100, 100, 200, 20),
      ];
      try {
        postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
        postBridge({
          type: "plannotator-bridge-find-and-mark",
          id: "race-ann",
          originalText: "Hover race text",
          annotationType: "comment",
        });
        await flushOverlay();
        const painted = visibleHighlights("pn-hl-comment").filter(
          (hl) => hl.getAttribute("data-annotation-id") === "race-ann",
        );
        expect(painted.length).toBeGreaterThan(0);

        // Schedule a hover hit test, then switch to pinpoint BEFORE the rAF
        // fires: the pending callback must not re-apply the class, and no
        // later re-render may resurrect it from stale hover state.
        document.dispatchEvent(new MouseEvent("mousemove", {
          bubbles: true,
          clientX: 150,
          clientY: 110,
        }));
        postBridge({ type: "plannotator-bridge-set-input-method", method: "pinpoint" });
        await flushOverlay();
        expect(painted[0]!.classList.contains("pn-hl-hover")).toBe(false);
        // Pinpoint-mode mousemoves skip the hover-clearing branch, so a
        // re-render is where stale state would resurface — it must not.
        postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
        await flushOverlay();
        expect(painted[0]!.classList.contains("pn-hl-hover")).toBe(false);
      } finally {
        (Range.prototype as { getClientRects: typeof originalGetClientRects }).getClientRects =
          originalGetClientRects;
      }
    });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("print passes are never budget-starved: every dead-but-recoverable target re-searches (3)", async () => {
    document.body.innerHTML = [0, 1, 2]
      .map((i) => `<p>Print recover text ${i}</p>`)
      .join("");
    for (let i = 0; i < 3; i++) {
      postBridge({
        type: "plannotator-bridge-find-and-mark",
        id: `print-recover-${i}`,
        originalText: `Print recover text ${i}`,
        annotationType: "comment",
      });
    }
    await flushOverlay();

    // Recreate identical content: every range dies, but the text is still
    // findable (dead-but-recoverable).
    document.body.innerHTML = [0, 1, 2]
      .map((i) => `<p>Print recover text ${i}</p>`)
      .join("");

    const originalGetClientRects = Range.prototype.getClientRects;
    const originalCreateTreeWalker = document.createTreeWalker.bind(document);
    let sweeps = 0;
    (document as { createTreeWalker: typeof document.createTreeWalker }).createTreeWalker = ((
      ...args: Parameters<typeof document.createTreeWalker>
    ) => {
      sweeps += 1;
      return originalCreateTreeWalker(...args);
    }) as typeof document.createTreeWalker;
    await withLayout(async () => {
      (Range.prototype as unknown as { getClientRects: () => DOMRect[] }).getClientRects = () => [
        rectOf(10, 20, 100, 20),
      ];
      try {
        // Printing is a user-initiated one-shot with no follow-up pass: the
        // 2-search reconcile budget must not apply, or a page with 3+ dead
        // targets silently prints fewer highlights.
        window.dispatchEvent(new Event("beforeprint"));
        expect(sweeps).toBe(3);
        const layer = document.querySelector<HTMLElement>("[data-plannotator-print-layer]");
        if (!layer) throw new Error("print layer missing");
        expect(layer.childNodes.length).toBe(3);
        window.dispatchEvent(new Event("afterprint"));
      } finally {
        (Range.prototype as { getClientRects: typeof originalGetClientRects }).getClientRects =
          originalGetClientRects;
        (document as { createTreeWalker: typeof document.createTreeWalker }).createTreeWalker =
          originalCreateTreeWalker;
      }
    });
    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("printing re-projects committed highlights into a paginating absolute layer (M4)", async () => {
    document.body.innerHTML = "<p>Printable highlight text</p>";
    const originalGetClientRects = Range.prototype.getClientRects;
    await withLayout(async () => {
      (Range.prototype as unknown as { getClientRects: () => DOMRect[] }).getClientRects = () => [
        rectOf(10, 20, 100, 20),
      ];
      try {
        postBridge({
          type: "plannotator-bridge-find-and-mark",
          id: "print-ann",
          originalText: "Printable highlight text",
          annotationType: "comment",
        });
        await flushOverlay();
        window.dispatchEvent(new Event("beforeprint"));
        const layer = document.querySelector<HTMLElement>(
          "[data-plannotator-print-layer]",
        );
        if (!layer) throw new Error("print layer missing");
        // On the ROOT element (not <body>): a page styling body
        // { position: relative } would otherwise shift every stripe by
        // body's document offset.
        expect(layer.parentElement).toBe(document.documentElement);
        // Absolute (not fixed) so it paginates with the content.
        expect(layer.style.position).toBe("absolute");
        const stripes = Array.from(layer.children) as HTMLElement[];
        expect(stripes.length).toBe(1);
        expect(stripes[0]!.style.position).toBe("absolute");
        expect(stripes[0]!.style.left).toBe("10px");
        expect(stripes[0]!.style.top).toBe("20px");
        expect(stripes[0]!.style.width).toBe("100px");
        expect(stripes[0]!.style.height).toBe("20px");
        // Highlights print; markers don't (parity with pre-overlay badges).
        expect(layer.querySelector("button")).toBeNull();
        window.dispatchEvent(new Event("afterprint"));
        expect(document.querySelector("[data-plannotator-print-layer]")).toBeNull();
      } finally {
        (Range.prototype as { getClientRects: typeof originalGetClientRects }).getClientRects =
          originalGetClientRects;
      }
    });
    // The injected CSS guards the layer against ever painting on screen.
    expect(ANNOTATION_HIGHLIGHT_CSS).toContain("[data-plannotator-print-layer]");
    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("clicking a committed highlight selects its annotation (M5 click-to-select)", async () => {
    document.body.innerHTML = "<p>big highlight target</p><p>small nested note</p>";
    postBridge({ type: "plannotator-bridge-set-vim-mode", enabled: false });
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    const originalGetClientRects = Range.prototype.getClientRects;
    const originalBodyRect = document.body.getBoundingClientRect;
    document.body.getBoundingClientRect = () => rectOf(0, 0, 1024, 768);
    (Range.prototype as unknown as { getClientRects: (this: Range) => DOMRect[] }).getClientRects =
      function (this: Range) {
        return this.toString().indexOf("small") >= 0
          ? [rectOf(40, 20, 60, 12)]
          : [rectOf(10, 10, 300, 100)];
      };
    const clickBody = (x: number, y: number, shift = false) => {
      document.body.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        shiftKey: shift,
      }));
    };
    try {
      postBridge({
        type: "plannotator-bridge-find-and-mark",
        id: "click-big",
        originalText: "big highlight target",
        annotationType: "comment",
      });
      await flushOverlay();
      postBridge({
        type: "plannotator-bridge-find-and-mark",
        id: "click-small",
        originalText: "small nested note",
        annotationType: "comment",
      });
      await flushOverlay();

      // Inside both rects: the smallest highlight wins the overlap.
      const overlapping = await collectMessages(
        ["plannotator-bridge-mark-click"],
        () => clickBody(50, 25),
      );
      expect(overlapping).toEqual([
        { type: "plannotator-bridge-mark-click", id: "click-small" },
      ]);

      // Inside only the big rect.
      const bigOnly = await collectMessages(
        ["plannotator-bridge-mark-click"],
        () => clickBody(200, 90),
      );
      expect(bigOnly).toEqual([
        { type: "plannotator-bridge-mark-click", id: "click-big" },
      ]);

      // Outside every rect: page clicks pass through untouched.
      const missed = await collectMessages(
        ["plannotator-bridge-mark-click"],
        () => clickBody(600, 600),
      );
      expect(missed.length).toBe(0);

      // Shift-clicks belong to multi-select, never click-to-select.
      const shifted = await collectMessages(
        ["plannotator-bridge-mark-click"],
        () => clickBody(50, 25, true),
      );
      expect(shifted.length).toBe(0);
    } finally {
      (Range.prototype as { getClientRects: typeof originalGetClientRects }).getClientRects =
        originalGetClientRects;
      document.body.getBoundingClientRect = originalBodyRect;
    }
    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("fixed-position targets ignore static overflow clippers (m3)", async () => {
    document.body.innerHTML =
      '<div id="wrap"><div id="fixed-el">Pinned banner</div></div>';
    const wrap = document.querySelector<HTMLElement>("#wrap")!;
    const fixedEl = document.querySelector<HTMLElement>("#fixed-el")!;
    wrap.style.overflow = "hidden";
    fixedEl.style.position = "fixed";
    await withLayout(async () => {
      wrap.getBoundingClientRect = () => rectOf(0, 0, 100, 50);
      // Fully visible in the viewport but entirely outside the static
      // clipper's box: overflow clipping does not apply to a fixed target
      // whose containing-block chain skips the clipper.
      fixedEl.getBoundingClientRect = () => rectOf(300, 300, 200, 50);
      postBridge({
        type: "plannotator-bridge-find-and-mark",
        id: "fixed-ann",
        originalText: "Text that exists nowhere on this page",
        annotationType: "comment",
        anchor: { selector: "#fixed-el", tagName: "div" },
      });
      await flushOverlay();
      expect(markersFor("fixed-ann").length).toBe(1);

      // Same geometry with static positioning: the clipper applies and the
      // detached marker is omitted (clip-container omission preserved).
      fixedEl.style.position = "";
      postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
      expect(markersFor("fixed-ann").length).toBe(0);

      // contain:layout makes the clipper a fixed containing block: its
      // overflow clipping then APPLIES to the fixed target again (5a).
      fixedEl.style.position = "fixed";
      wrap.style.contain = "layout";
      postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
      expect(markersFor("fixed-ann").length).toBe(0);
      wrap.style.contain = "";
    });
    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("markers omit when the target scrolls out of its clip container (omission preserved)", async () => {
    document.body.innerHTML =
      '<div id="clipwrap"><div id="clipped-el">Clipped away</div></div>';
    const clipwrap = document.querySelector<HTMLElement>("#clipwrap")!;
    const clippedEl = document.querySelector<HTMLElement>("#clipped-el")!;
    clipwrap.style.overflow = "hidden";
    await withLayout(async () => {
      clipwrap.getBoundingClientRect = () => rectOf(0, 0, 200, 100);
      clippedEl.getBoundingClientRect = () => rectOf(0, 150, 200, 50); // scrolled past the edge
      postBridge({
        type: "plannotator-bridge-find-and-mark",
        id: "clip-omit",
        originalText: "Text that exists nowhere on this page",
        annotationType: "comment",
        anchor: { selector: "#clipped-el", tagName: "div" },
      });
      await flushOverlay();
      expect(markersFor("clip-omit").length).toBe(0);

      clippedEl.getBoundingClientRect = () => rectOf(0, 20, 200, 50); // scrolled back in
      postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
      expect(markersFor("clip-omit").length).toBe(1);
    });
    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("border boxes that duplicate line rects are dropped (m7 containment filter)", async () => {
    document.body.innerHTML = "<p>Redline paragraph text</p>";
    const originalGetClientRects = Range.prototype.getClientRects;
    await withLayout(async () => {
      // Range.getClientRects() returns BOTH the contained element's border
      // box AND its line boxes; painting all three double-paints the
      // translucent fill and duplicates the strike line.
      (Range.prototype as unknown as { getClientRects: () => DOMRect[] }).getClientRects = () => [
        rectOf(10, 10, 300, 60), // border box containing both lines
        rectOf(10, 10, 300, 20), // line 1
        rectOf(10, 40, 200, 20), // line 2
      ];
      try {
        postBridge({
          type: "plannotator-bridge-find-and-mark",
          id: "redline-ann",
          originalText: "Redline paragraph text",
          annotationType: "deletion",
        });
        await flushOverlay();
        const painted = visibleHighlights("pn-hl-deletion").filter(
          (el) => el.getAttribute("data-annotation-id") === "redline-ann",
        );
        expect(painted.length).toBe(2);
        expect(painted.map((el) => el.style.height)).toEqual(["20px", "20px"]);
      } finally {
        (Range.prototype as { getClientRects: typeof originalGetClientRects }).getClientRects =
          originalGetClientRects;
      }
    });
    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("anchors re-resolving to one element render one marker (m10 refresh dedup)", async () => {
    document.body.innerHTML =
      '<div id="m10-a">First</div><div data-testid="m10-b">Second</div>';
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "dedup-ann",
      originalText: "Text that exists nowhere on this page",
      annotationType: "comment",
      anchor: { selector: "#m10-a", tagName: "div" },
      additionalAnchors: [{ selector: 'div[data-testid="m10-b"]', tagName: "div" }],
    });
    await flushOverlay();
    expect(markersFor("dedup-ann").length).toBe(2);

    // The page rerenders so BOTH anchors resolve to the same element: only
    // one marker may render (coincident same-number markers would spread).
    document.body.innerHTML = '<div id="m10-a" data-testid="m10-b">Merged</div>';
    bumpDomGeneration();
    postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
    expect(markersFor("dedup-ann").length).toBe(1);

    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("clear-marks clears synced numbering (m11)", async () => {
    document.body.innerHTML = '<div id="renum">Target</div>';
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "renum-ann",
      originalText: "Text that exists nowhere on this page",
      annotationType: "comment",
      anchor: { selector: "#renum", tagName: "div" },
    });
    await flushOverlay();
    postBridge({
      type: "plannotator-bridge-sync-annotations",
      annotations: [{ id: "renum-ann", number: 7 }],
    });
    expect(markerNumber(markersFor("renum-ann")[0]!)).toBe("7");

    // clear-marks then re-register the SAME id: the stale synced number must
    // not leak — fallback numbering restarts at 1.
    postBridge({ type: "plannotator-bridge-clear-marks" });
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "renum-ann",
      originalText: "Text that exists nowhere on this page",
      annotationType: "comment",
      anchor: { selector: "#renum", tagName: "div" },
    });
    await flushOverlay();
    expect(markerNumber(markersFor("renum-ann")[0]!)).toBe("1");

    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("marker anchors to the TRUE last client rect past the paint cap (m12)", async () => {
    document.body.innerHTML = "<p>Long wrapped selection</p>";
    const originalGetClientRects = Range.prototype.getClientRects;
    await withLayout(async () => {
      const rects: DOMRect[] = [];
      for (let i = 0; i < 60; i++) rects.push(rectOf(10, 10 + i * 5, 100, 5));
      (Range.prototype as unknown as { getClientRects: () => DOMRect[] }).getClientRects = () =>
        rects;
      try {
        postBridge({
          type: "plannotator-bridge-find-and-mark",
          id: "long-ann",
          originalText: "Long wrapped selection",
          annotationType: "comment",
        });
        await flushOverlay();
        // Painting caps at 48 rects…
        const painted = visibleHighlights("pn-hl-comment").filter(
          (el) => el.getAttribute("data-annotation-id") === "long-ann",
        );
        expect(painted.length).toBe(48);
        // …but the marker sits at the selection TAIL (60th rect), not at the
        // 48th rect mid-selection.
        const longMarkers = markersFor("long-ann");
        expect(longMarkers.length).toBe(1);
        expect(longMarkers[0]!.style.left).toBe("110px");
        expect(longMarkers[0]!.style.top).toBe("307.5px");
      } finally {
        (Range.prototype as { getClientRects: typeof originalGetClientRects }).getClientRects =
          originalGetClientRects;
      }
    });
    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("pinpoint hover over a placed marker advertises the marker, not the element beneath (m6)", async () => {
    document.body.innerHTML = '<p id="under">Beneath paragraph</p><div id="m6-t">Marked</div>';
    postBridge({ type: "plannotator-bridge-set-vim-mode", enabled: false });
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "hover-ann",
      originalText: "Text that exists nowhere on this page",
      annotationType: "comment",
      anchor: { selector: "#m6-t", tagName: "div" },
    });
    await flushOverlay();
    postBridge({
      type: "plannotator-bridge-sync-annotations",
      annotations: [{ id: "hover-ann", number: 3 }],
    });
    const markerBtn = markersFor("hover-ann")[0];
    if (!markerBtn) throw new Error("marker missing");
    const originalElementFromPoint = document.elementFromPoint;
    (document as { elementFromPoint: typeof document.elementFromPoint }).elementFromPoint = () =>
      markerBtn as unknown as Element;
    try {
      postBridge({ type: "plannotator-bridge-set-input-method", method: "pinpoint" });
      hoverAt(document.body, 60, 60);
      // Hover shows the MARKER's identity (the click selects its comment)…
      const label = document.querySelector<HTMLElement>("[data-plannotator-pinpoint-label]");
      expect(label?.style.display).toBe("block");
      expect(label?.textContent).toBe("Comment 3");
      // …with no annotate affordance for the element beneath.
      const box = document.querySelector<HTMLElement>("[data-plannotator-pinpoint-box]");
      expect(box?.style.display ?? "none").toBe("none");
      // m8: the label paints AFTER the overlay host (equal z-index resolves
      // by DOM order), so marker bubbles can never occlude it.
      const host = overlayHost()!;
      expect(label!.parentElement).toBe(document.documentElement);
      expect(
        (label!.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_PRECEDING) !== 0,
      ).toBe(true);

      // Moving off the bubble restores normal element hover/annotate.
      const under = document.querySelector<HTMLElement>("#under")!;
      (document as { elementFromPoint: typeof document.elementFromPoint }).elementFromPoint =
        () => under;
      hoverAt(under, 200, 200);
      expect(label?.textContent).toBe("Paragraph");
    } finally {
      (document as { elementFromPoint: typeof document.elementFromPoint }).elementFromPoint =
        originalElementFromPoint;
    }
    postBridge({ type: "plannotator-bridge-set-input-method", method: "drag" });
    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("rect collection is capped at 48 with the containment filter, marker at the true tail (perf bound)", async () => {
    document.body.innerHTML = "<p>Huge wrapped selection</p>";
    const originalGetClientRects = Range.prototype.getClientRects;
    await withLayout(async () => {
      // 60 rects: index 0 is a border box strictly containing lines 1..10;
      // only the first 48 may ever be materialized (a huge selection can
      // yield thousands of rects per reconcile frame), the containment
      // filter runs on that capped list, and the marker still anchors the
      // TRUE final rect read by index off the live list.
      const rects: DOMRect[] = [rectOf(10, 10, 100, 50)];
      for (let i = 1; i < 60; i++) rects.push(rectOf(10, 10 + (i - 1) * 5, 100, 5));
      (Range.prototype as unknown as { getClientRects: () => DOMRect[] }).getClientRects = () =>
        rects;
      try {
        postBridge({
          type: "plannotator-bridge-find-and-mark",
          id: "huge-ann",
          originalText: "Huge wrapped selection",
          annotationType: "comment",
        });
        await flushOverlay();
        const painted = visibleHighlights("pn-hl-comment").filter(
          (el) => el.getAttribute("data-annotation-id") === "huge-ann",
        );
        // 48 collected minus the containment-dropped border box.
        expect(painted.length).toBe(47);
        expect(painted.some((el) => el.style.height === "50px")).toBe(false);
        // True tail: rects[59] (top 300, height 5) — not the 48th entry.
        const hugeMarkers = markersFor("huge-ann");
        expect(hugeMarkers.length).toBe(1);
        expect(hugeMarkers[0]!.style.left).toBe("110px");
        expect(hugeMarkers[0]!.style.top).toBe("302.5px");
      } finally {
        (Range.prototype as { getClientRects: typeof originalGetClientRects }).getClientRects =
          originalGetClientRects;
      }
    });
    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("the page observer watches documentElement; body swaps unlock re-search (M3 scope)", async () => {
    const observer = capturedObservers[0];
    if (!observer) throw new Error("bridge page observer was not captured");
    // Scope: a body-scoped observer sees NO record when the page swaps the
    // <body> element itself (documentElement.replaceChild), permanently
    // locking dead-target re-search behind a generation that never advances.
    expect(observer.targets).toContain(document.documentElement);
    for (const observed of observer.targets) {
      expect(observed.nodeName).not.toBe("BODY");
    }

    document.body.innerHTML = "<p>Body swap text</p>";
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "swap-ann",
      originalText: "Body swap text",
      annotationType: "comment",
    });
    await flushOverlay();
    expect(
      visibleHighlights("pn-hl-comment").some(
        (el) => el.getAttribute("data-annotation-id") === "swap-ann",
      ),
    ).toBe(true);

    // The body is swapped for an interim skeleton: the record lands on
    // documentElement. The free retry runs against the skeleton and fails.
    document.body.innerHTML = "<p>interim skeleton</p>";
    deliverPageMutations([{
      type: "childList",
      target: document.documentElement,
      addedNodes: [document.body] as unknown as NodeList,
      removedNodes: [] as unknown as NodeList,
    }]);
    postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
    expect(
      visibleHighlights("pn-hl-comment").some(
        (el) => el.getAttribute("data-annotation-id") === "swap-ann",
      ),
    ).toBe(false);

    // Overlay-only childList writes on the root (host/label/print-layer
    // appends) must NOT bump the generation: no re-search may run.
    const host = overlayHost();
    if (!host) throw new Error("overlay host missing");
    const originalCreateTreeWalker = document.createTreeWalker.bind(document);
    let sweeps = 0;
    (document as { createTreeWalker: typeof document.createTreeWalker }).createTreeWalker = ((
      ...args: Parameters<typeof document.createTreeWalker>
    ) => {
      sweeps += 1;
      return originalCreateTreeWalker(...args);
    }) as typeof document.createTreeWalker;
    try {
      deliverPageMutations([{
        type: "childList",
        target: document.documentElement,
        addedNodes: [host] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      }]);
      postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
      postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
      expect(sweeps).toBe(0);
    } finally {
      (document as { createTreeWalker: typeof document.createTreeWalker }).createTreeWalker =
        originalCreateTreeWalker;
    }

    // The text returns inside the (new) body — inside the documentElement
    // observer's subtree — and the next real record (after the failure
    // backoff) unlocks re-search.
    document.body.innerHTML = "<p>Body swap text</p>";
    advancePastDeadSearchBackoff();
    deliverPageMutations([{
      type: "childList",
      target: document.documentElement,
      addedNodes: [document.body] as unknown as NodeList,
      removedNodes: [] as unknown as NodeList,
    }]);
    postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
    expect(
      visibleHighlights("pn-hl-comment").some(
        (el) => el.getAttribute("data-annotation-id") === "swap-ann",
      ),
    ).toBe(true);

    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });

  test("dedup keeps the VISIBLE marker when a hidden sibling target shares the element (5b)", async () => {
    document.body.innerHTML =
      '<div id="m10-a">First</div><div data-testid="m10-b">Second</div>';
    postBridge({
      type: "plannotator-bridge-find-and-mark",
      id: "dedup-vis",
      originalText: "Text that exists nowhere on this page",
      annotationType: "comment",
      anchor: { selector: "#m10-a", tagName: "div", point: { x: 0.05, y: 0.5 } },
      additionalAnchors: [
        { selector: 'div[data-testid="m10-b"]', tagName: "div", point: { x: 0.75, y: 0.5 } },
      ],
    });
    await flushOverlay();
    // Both anchors re-resolve to ONE merged element inside a clipper that
    // hides the FIRST target's point but not the second's: dedup must run
    // among PLACED markers, keeping the visible one — not consume the
    // element's slot on the hidden first target and render nothing.
    document.body.innerHTML =
      '<div id="m10-wrap"><div id="m10-a" data-testid="m10-b">Merged</div></div>';
    const wrap = document.querySelector<HTMLElement>("#m10-wrap")!;
    const merged = document.querySelector<HTMLElement>("#m10-a")!;
    wrap.style.overflow = "hidden";
    await withLayout(async () => {
      wrap.getBoundingClientRect = () => rectOf(100, 0, 100, 100);
      merged.getBoundingClientRect = () => rectOf(0, 0, 200, 50);
      bumpDomGeneration();
      postBridge({ type: "plannotator-bridge-sync-annotations", annotations: [] });
      const dedupMarkers = markersFor("dedup-vis");
      expect(dedupMarkers.length).toBe(1);
      // The SECOND target's point (x 0.75 -> 150px) survived; y 25 clamps
      // to the 29px viewport inset (rendering-only clamp).
      expect(dedupMarkers[0]!.style.left).toBe("150px");
      expect(dedupMarkers[0]!.style.top).toBe("29px");
    });
    postBridge({ type: "plannotator-bridge-clear-marks" });
    document.body.replaceChildren();
  });
});

describe("injectIntoHead", () => {
  test("splices before </head> when present, else prepends", () => {
    expect(injectIntoHead("<html><head><title>t</title></head><body/></html>", "[X]")).toBe(
      "<html><head><title>t</title>[X]</head><body/></html>",
    );
    expect(injectIntoHead("<p>no head</p>", "[X]")).toBe("[X]<p>no head</p>");
  });

  test("removes document-authored CSP meta tags so the bridge can execute", () => {
    // The exact tag Plannotator's own portable guided-review exports embed;
    // with it present the inline bridge script is blocked and annotation dies.
    const csp =
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src \'none\'; connect-src \'none\'; media-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'; frame-src \'none\'">';
    const out = injectIntoHead(`<html><head>${csp}<title>t</title></head><body/></html>`, "[X]");
    expect(out).not.toMatch(/content-security-policy/i);
    expect(out).toContain("[X]</head>");
    expect(out).toContain("<title>t</title>");

    // Attribute-order, quoting, casing, and self-closing variants.
    const variants = [
      "<meta content=\"default-src 'none'\" http-equiv=content-security-policy>",
      "<META HTTP-EQUIV='Content-Security-Policy' CONTENT=\"script-src 'none'\" />",
      "<meta http-equiv = \" content-security-policy \" content=\"default-src 'self'\">",
    ];
    for (const tag of variants) {
      expect(injectIntoHead(`<head>${tag}</head>`, "[X]")).not.toMatch(/http-equiv/i);
    }

    // Other meta tags survive untouched.
    const keep = '<meta http-equiv="refresh" content="0"><meta charset="utf-8">';
    expect(injectIntoHead(`<head>${keep}</head>`, "[X]")).toContain(keep);
  });
});
