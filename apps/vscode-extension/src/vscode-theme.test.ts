/**
 * Theme-bridge precedence tests (issue #1053).
 *
 * The bridge writes INLINE custom properties on <html>, the element
 * ThemeProvider stamps `theme-<palette>` / `light` on. An inline property beats
 * every `.theme-*` rule, so a bridge that paints unconditionally makes the
 * user's own theme choice unreachable: picking Light in a dark IDE used to
 * leave dark VS Code tokens under a `.light` class. These tests pin who wins.
 *
 * The listener is a string of browser JS, so it is evaluated with `window`,
 * `document` and `MutationObserver` passed in as parameters. That shadows the
 * globals, which both isolates each test (its own root element, its own message
 * listeners, its own cookie jar) and keeps the harness honest: only the two
 * DOM surfaces the bridge is allowed to read are provided.
 *
 * Requires DOM_TESTS=1 (happy-dom preload). Run:
 *   DOM_TESTS=1 bun test apps/vscode-extension/src/vscode-theme.test.ts
 */
/// <reference lib="dom" />
// DOM types are pulled in for this file alone: the extension host is Node and
// its tsconfig deliberately ships `lib: ["ESNext"]`, so the source cannot reach
// for browser globals by accident. Only this harness runs in a DOM.
import { describe, it, expect } from "bun:test";
import { buildThemeListenerScript, DEFAULT_THEME_CLASS } from "./vscode-theme";
import {
  applyPanelCookieDefaults,
  PANEL_SEED_COOKIE,
  PANEL_SEED_VERSION,
} from "./cookie-proxy";

const hasDom = typeof document !== "undefined";

interface ThemeMessage {
  type: string;
  tokens: Record<string, string>;
  themeKind: string;
}

/** A dark VS Code theme, as the wrapper page reports it. */
const IDE_DARK: ThemeMessage = {
  type: "plannotator-vscode-theme",
  themeKind: "vscode-dark",
  tokens: {
    "--vscode-editor-background": "#1e1e1e",
    "--vscode-editor-foreground": "#d4d4d4",
  },
};

/** A light VS Code theme. */
const IDE_LIGHT: ThemeMessage = {
  type: "plannotator-vscode-theme",
  themeKind: "vscode-light",
  tokens: {
    "--vscode-editor-background": "#ffffff",
    "--vscode-editor-foreground": "#333333",
  },
};

interface Bridge {
  /** Stands in for the app's <html>, which ThemeProvider owns. */
  root: HTMLElement;
  /** Deliver a theme message from the wrapper webview. */
  post: (msg: ThemeMessage) => void;
  /** Whether the bridge painted a given Plannotator variable. */
  override: (name: string) => string;
  vscodeFlag: () => unknown;
}

/** Evaluate the injected listener against an isolated DOM. */
function mountBridge(classes: string, cookie = ""): Bridge {
  const root = document.createElement("html");
  root.className = classes;

  const listeners: Array<(e: { data: unknown }) => void> = [];
  const fakeWindow: Record<string, unknown> = {
    addEventListener(type: string, fn: (e: { data: unknown }) => void) {
      if (type === "message") listeners.push(fn);
    },
  };
  const fakeDocument = { documentElement: root, cookie };

  const js = buildThemeListenerScript()
    .replace(/^<script>/, "")
    .replace(/<\/script>$/, "");
  new Function("window", "document", "MutationObserver", js)(
    fakeWindow,
    fakeDocument,
    MutationObserver,
  );

  return {
    root,
    post: (msg) => {
      for (const fn of listeners) fn({ data: msg });
    },
    override: (name) => root.style.getPropertyValue(name),
    vscodeFlag: () => fakeWindow.__PLANNOTATOR_VSCODE,
  };
}

/** Let a MutationObserver callback run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe.skipIf(!hasDom)("theme bridge precedence", () => {
  it("leaves the app's light theme alone in a dark IDE (issue #1053)", () => {
    const bridge = mountBridge(`${DEFAULT_THEME_CLASS} light`, "plannotator-theme=light");

    bridge.post(IDE_DARK);

    // The reported bug: dark editor tokens painted over a light surface.
    expect(bridge.override("--background")).toBe("");
    expect(bridge.override("--foreground")).toBe("");
    expect(bridge.override("--muted")).toBe("");
    // And the class the user's choice produced survives.
    expect(bridge.root.classList.contains("light")).toBe(true);
  });

  it("still syncs VS Code colors when the app is on the IDE's side", () => {
    const bridge = mountBridge(DEFAULT_THEME_CLASS, "plannotator-theme=dark");

    bridge.post(IDE_DARK);

    expect(bridge.override("--background")).toBe("#1e1e1e");
    expect(bridge.override("--foreground")).toBe("#d4d4d4");
    // --muted is derived by brightening the editor background for a dark IDE.
    expect(bridge.override("--muted")).toBe("rgb(50,50,50)");
  });

  it("never stands in for a palette the user picked", () => {
    // Modes agree, so only the palette choice keeps the bridge off.
    const bridge = mountBridge("theme-nord", "plannotator-theme=dark");

    bridge.post(IDE_DARK);

    expect(bridge.override("--background")).toBe("");
  });

  it("removes its overrides when the user switches to Light mid-session", async () => {
    const bridge = mountBridge(DEFAULT_THEME_CLASS, "plannotator-theme=dark");
    bridge.post(IDE_DARK);
    expect(bridge.override("--background")).toBe("#1e1e1e");

    // What ThemeProvider.applyThemeClasses does when Light is chosen.
    bridge.root.className = `${DEFAULT_THEME_CLASS} light`;
    await settle();

    expect(bridge.override("--background")).toBe("");
    expect(bridge.override("--muted")).toBe("");
  });

  it("maps System onto the IDE's theme kind", () => {
    // Inside VS Code the surrounding system is the IDE, so System defers to it
    // even though the app rendered dark from its own signal.
    const bridge = mountBridge(DEFAULT_THEME_CLASS, "plannotator-theme=system");

    bridge.post(IDE_LIGHT);

    expect(bridge.root.classList.contains("light")).toBe(true);
    expect(bridge.override("--background")).toBe("#ffffff");
  });

  it("does not force the mode of a user who pinned Dark in a light IDE", () => {
    const bridge = mountBridge(DEFAULT_THEME_CLASS, "plannotator-theme=dark");

    bridge.post(IDE_LIGHT);

    expect(bridge.root.classList.contains("light")).toBe(false);
    expect(bridge.override("--background")).toBe("");
  });

  it("waits for ThemeProvider to mount before deciding", async () => {
    // The wrapper posts on load, which can beat the app's first render; the
    // class list is empty until then and must not be read as "default palette".
    const bridge = mountBridge("", "plannotator-theme=dark");
    bridge.post(IDE_DARK);
    expect(bridge.override("--background")).toBe("");

    bridge.root.className = DEFAULT_THEME_CLASS;
    await settle();

    expect(bridge.override("--background")).toBe("#1e1e1e");
  });

  it("marks the window so the app knows it runs inside VS Code", () => {
    // useEditorAnnotations keys off this flag; the bridge is where it is set.
    expect(mountBridge(DEFAULT_THEME_CLASS).vscodeFlag()).toBe(true);
  });
});

/**
 * The seed and the bridge are correct on their own and were still wrong
 * together: seeding only an ABSENT mode meant an upgraded panel kept the `dark`
 * the app had auto-persisted, and the bridge — correctly — read that as a
 * choice and stayed off. These run the real seeding function into the real
 * bridge, which is the only place that gap is visible.
 */
describe.skipIf(!hasDom)("panel cookie seed feeding the bridge", () => {
  /** The jar the proxy hands the page, as a cookie string. */
  function seededCookie(store: Record<string, string>): string {
    return Object.entries(applyPanelCookieDefaults(store))
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  it("upgrades a legacy dark panel to follow a light IDE (issue #1053)", () => {
    // A panel that ran before the seeding rules: `dark` in the store, written
    // by the app on first mount, never chosen by anyone.
    const bridge = mountBridge(
      DEFAULT_THEME_CLASS,
      seededCookie({ "plannotator-theme": "dark" }),
    );

    bridge.post(IDE_LIGHT);

    expect(bridge.root.classList.contains("light")).toBe(true);
    expect(bridge.override("--background")).toBe("#ffffff");
  });

  it("keeps a Dark chosen after the migration pinned in a light IDE", () => {
    const bridge = mountBridge(
      DEFAULT_THEME_CLASS,
      seededCookie({
        "plannotator-theme": "dark",
        [PANEL_SEED_COOKIE]: PANEL_SEED_VERSION,
      }),
    );

    bridge.post(IDE_LIGHT);

    expect(bridge.root.classList.contains("light")).toBe(false);
    expect(bridge.override("--background")).toBe("");
  });

  it("still follows the IDE on a fresh install", () => {
    const bridge = mountBridge(DEFAULT_THEME_CLASS, seededCookie({}));

    bridge.post(IDE_LIGHT);

    expect(bridge.root.classList.contains("light")).toBe(true);
    expect(bridge.override("--background")).toBe("#ffffff");
  });

  it("leaves a stored Light pinned in a dark IDE, marked or not", () => {
    const stores: Record<string, string>[] = [
      { "plannotator-theme": "light" },
      { "plannotator-theme": "light", [PANEL_SEED_COOKIE]: PANEL_SEED_VERSION },
    ];
    for (const store of stores) {
      const bridge = mountBridge(`${DEFAULT_THEME_CLASS} light`, seededCookie(store));

      bridge.post(IDE_DARK);

      expect(bridge.root.classList.contains("light")).toBe(true);
      expect(bridge.override("--background")).toBe("");
    }
  });
});
