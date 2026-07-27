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

  beforeAll(() => {
    new Function(BRIDGE_SCRIPT)();
  });

  function postBridge(data: Record<string, unknown>) {
    window.dispatchEvent(
      new MessageEvent("message", {
        data,
        source: window,
      }),
    );
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
    expect(
      document.querySelector('[data-bind-id="vim-committed-range"]')?.textContent,
    ).toBe("Alpha ");

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
    expect(
      document.querySelector('[data-bind-id="vim-committed-block-range"]')?.textContent,
    ).toBe("Whole block target");

    postBridge({
      type: "plannotator-bridge-set-vim-mode",
      enabled: false,
    });
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
});
