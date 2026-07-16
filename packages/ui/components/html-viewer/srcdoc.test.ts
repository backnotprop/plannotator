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
import { describe, expect, test } from "bun:test";
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
  function postTheme(data: Record<string, unknown>) {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "plannotator-bridge-theme", ...data },
      }),
    );
  }

  test("author root only receives --pn-* on theme flip; opt-in restores bare push", () => {
    new Function(BRIDGE_SCRIPT)();
    const root = document.documentElement;

    postTheme({
      tokens: { "--pn-muted": "red", "--muted": "blue" },
      isLight: true,
      hostTheme: false,
    });
    expect(root.style.getPropertyValue("--pn-muted")).toBe("red");
    expect(root.style.getPropertyValue("--muted")).toBe("");
    expect(root.classList.contains("light")).toBe(false);

    postTheme({
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
});

describe("injectIntoHead", () => {
  test("splices before </head> when present, else prepends", () => {
    expect(injectIntoHead("<html><head><title>t</title></head><body/></html>", "[X]")).toBe(
      "<html><head><title>t</title>[X]</head><body/></html>",
    );
    expect(injectIntoHead("<p>no head</p>", "[X]")).toBe("[X]<p>no head</p>");
  });
});
