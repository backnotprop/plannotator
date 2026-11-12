/// <reference lib="dom" />
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

const IDE_DARK: ThemeMessage = {
  type: "plannotator-vscode-theme",
  themeKind: "vscode-dark",
  tokens: {
    "--vscode-editor-background": "#1e1e1e",
    "--vscode-editor-foreground": "#d4d4d4",
  },
};

const IDE_LIGHT: ThemeMessage = {
  type: "plannotator-vscode-theme",
  themeKind: "vscode-light",
  tokens: {
    "--vscode-editor-background": "#ffffff",
    "--vscode-editor-foreground": "#333333",
  },
};

interface Bridge {
  root: HTMLElement;
  post: (msg: ThemeMessage) => void;
  override: (name: string) => string;
  vscodeFlag: () => unknown;
}

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

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe.skipIf(!hasDom)("theme bridge precedence", () => {
  it("leaves the app's light theme alone in a dark IDE (issue #1053)", () => {
    const bridge = mountBridge(`${DEFAULT_THEME_CLASS} light`, "plannotator-theme=light");

    bridge.post(IDE_DARK);

    expect(bridge.override("--background")).toBe("");
    expect(bridge.override("--foreground")).toBe("");
    expect(bridge.override("--muted")).toBe("");
    expect(bridge.root.classList.contains("light")).toBe(true);
  });

  it("still syncs VS Code colors when the app is on the IDE's side", () => {
    const bridge = mountBridge(DEFAULT_THEME_CLASS, "plannotator-theme=dark");

    bridge.post(IDE_DARK);

    expect(bridge.override("--background")).toBe("#1e1e1e");
    expect(bridge.override("--foreground")).toBe("#d4d4d4");
    expect(bridge.override("--muted")).toBe("rgb(50,50,50)");
  });

  it("never stands in for a palette the user picked", () => {
    const bridge = mountBridge("theme-nord", "plannotator-theme=dark");

    bridge.post(IDE_DARK);

    expect(bridge.override("--background")).toBe("");
  });

  it("removes its overrides when the user switches to Light mid-session", async () => {
    const bridge = mountBridge(DEFAULT_THEME_CLASS, "plannotator-theme=dark");
    bridge.post(IDE_DARK);
    expect(bridge.override("--background")).toBe("#1e1e1e");

    bridge.root.className = `${DEFAULT_THEME_CLASS} light`;
    await settle();

    expect(bridge.override("--background")).toBe("");
    expect(bridge.override("--muted")).toBe("");
  });

  it("maps System onto the IDE's theme kind", () => {
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
    const bridge = mountBridge("", "plannotator-theme=dark");
    bridge.post(IDE_DARK);
    expect(bridge.override("--background")).toBe("");

    bridge.root.className = DEFAULT_THEME_CLASS;
    await settle();

    expect(bridge.override("--background")).toBe("#1e1e1e");
  });

  it("marks the window so the app knows it runs inside VS Code", () => {
    expect(mountBridge(DEFAULT_THEME_CLASS).vscodeFlag()).toBe(true);
  });

  it("lands an IDE theme change in one frame, then lets transitions back", async () => {
    const bridge = mountBridge(DEFAULT_THEME_CLASS, "plannotator-theme=system");

    bridge.post(IDE_LIGHT);

    expect(bridge.root.classList.contains("light")).toBe(true);
    expect(bridge.root.classList.contains("pn-theme-switching")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bridge.root.classList.contains("pn-theme-switching")).toBe(false);
  });
});

describe.skipIf(!hasDom)("panel cookie seed feeding the bridge", () => {
  function seededCookie(store: Record<string, string>): string {
    return Object.entries(applyPanelCookieDefaults(store))
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  it("upgrades a legacy dark panel to follow a light IDE (issue #1053)", () => {
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
