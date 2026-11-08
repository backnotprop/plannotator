/**
 * A page that uses history or storage while it builds itself renders in the
 * viewer's sandboxed frame (sandboxShim.ts).
 *
 * The frame below follows what Chromium does in a frame sandboxed with
 * scripts and without allow-same-origin (checked in Chrome against the Inbox
 * with the prototype that showed blank): a srcdoc document (`about:srcdoc`)
 * may change only its fragment, the URL a page passes resolves against the
 * viewer's `<base href>`, a served page may move within its origin, and
 * reading `localStorage` / `sessionStorage` throws a SecurityError.
 */
import { describe, expect, test } from "bun:test";
import vm from "node:vm";
import { BRIDGE_SCRIPT } from "./bridge-script";
import { SANDBOX_SHIM_SCRIPT } from "./sandboxShim";
import { injectSandboxShim } from "./srcdoc";

const ASSET_BASE = "http://localhost:4000/api/html-assets/tok/";

function securityError(message: string): Error {
  return Object.assign(new Error(message), { name: "SecurityError" });
}

function opaqueFrame(documentUrl: string, globals: Record<string, unknown> = {}) {
  let href = documentUrl;
  let state: unknown = null;
  const change = (next: unknown, _unused: string, url?: string | URL | null) => {
    if (url !== undefined && url !== null) {
      const target = new URL(String(url), ASSET_BASE);
      const current = new URL(href);
      const allowed = /^https?:$/.test(current.protocol)
        ? target.origin === current.origin
        : target.href.split("#")[0] === href.split("#")[0];
      if (!allowed) {
        throw securityError(`A history state object with URL '${target.href}' cannot be created in a document with origin 'null' and URL '${href}'.`);
      }
      href = target.href;
    }
    state = next;
  };
  const win: Record<string, unknown> = {
    URL,
    document: { baseURI: ASSET_BASE },
    history: { pushState: change, replaceState: change, get state() { return state; } },
    location: {
      get href() { return href; },
      get hash() { const at = href.indexOf("#"); return at < 0 ? "" : href.slice(at); },
    },
  };
  for (const name of ["localStorage", "sessionStorage"]) {
    Object.defineProperty(win, name, {
      configurable: true,
      enumerable: true,
      get() { throw securityError(`Failed to read the '${name}' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.`); },
    });
  }
  win.window = win;
  Object.assign(win, globals);
  const context = vm.createContext(win);
  return {
    run: (source: string) => vm.runInContext(source, context),
    get href() { return href; },
  };
}

/** The boot of the prototype that rendered blank: read the hash and storage, write the hash, then draw. */
const PROTOTYPE_BOOT = `
  var theme = localStorage.getItem('theme') || 'light';
  history.replaceState(null, '', '#state=C4&theme=' + theme + '&vp=phone');
  localStorage.setItem('seen', '1');
  sessionStorage.tab = 'states';
  window.drawn = { hash: location.hash, seen: localStorage.getItem('seen'), tab: sessionStorage.getItem('tab'), keys: Object.keys(sessionStorage) };
`;

describe("a page that uses history and storage as it builds itself", () => {
  test("stops before it draws in the bare sandboxed frame (what the shim is for)", () => {
    const frame = opaqueFrame("about:srcdoc");
    expect(() => frame.run("localStorage.getItem('theme')")).toThrow("sandboxed");
    expect(() => frame.run("history.replaceState(null, '', '#state=C4')")).toThrow("cannot be created");
  });

  test("draws in a srcdoc frame, its fragment on its own address", () => {
    const frame = opaqueFrame("about:srcdoc");
    frame.run(SANDBOX_SHIM_SCRIPT);
    frame.run(PROTOTYPE_BOOT);
    expect(frame.run("JSON.stringify(window.drawn)")).toBe(
      JSON.stringify({ hash: "#state=C4&theme=light&vp=phone", seen: "1", tab: "states", keys: ["tab"] }),
    );
    expect(frame.href).toBe("about:srcdoc#state=C4&theme=light&vp=phone");
  });

  test("a served page keeps its own address, not its folder's", () => {
    const frame = opaqueFrame("http://localhost:4000/api/inbox/pages/abc");
    frame.run(SANDBOX_SHIM_SCRIPT);
    frame.run("history.pushState({ step: 2 }, '', '#step=2')");
    expect(frame.href).toBe("http://localhost:4000/api/inbox/pages/abc#step=2");
  });

  test("a URL the frame refuses keeps the state and the fragment, and the page runs on", () => {
    const frame = opaqueFrame("about:srcdoc");
    frame.run(SANDBOX_SHIM_SCRIPT);
    frame.run("history.replaceState({ step: 3 }, '', '/other/page.html?x=1#three'); window.after = true;");
    expect(frame.href).toBe("about:srcdoc#three");
    expect(frame.run("JSON.stringify(history.state) + window.after")).toBe('{"step":3}true');
  });

  test("running it again (the bridge after the head) keeps what the page stored", () => {
    const frame = opaqueFrame("about:srcdoc");
    frame.run(SANDBOX_SHIM_SCRIPT);
    frame.run("localStorage.setItem('theme', 'dark')");
    frame.run(SANDBOX_SHIM_SCRIPT);
    frame.run("history.replaceState(null, '', '#a')");
    expect(frame.run("localStorage.getItem('theme')")).toBe("dark");
    expect(frame.href).toBe("about:srcdoc#a");
  });
});

const SHIM_TAG = `<script>${SANDBOX_SHIM_SCRIPT}</script>`;

describe("where the shim runs", () => {
  test("before the page's own head scripts", () => {
    const page = '<!doctype html><html lang="en"><head data-x="1"><script>PAGE_HEAD()</script></head><body></body></html>';
    expect(injectSandboxShim(page)).toBe(`<!doctype html><html lang="en"><head data-x="1">${SHIM_TAG}<script>PAGE_HEAD()</script></head><body></body></html>`);
  });

  test("never inside a comment, a title or an attribute that names <head>", () => {
    expect(injectSandboxShim('<!doctype html><!-- the <head> goes here --><html><head><script>boot()</script></head>'))
      .toBe(`<!doctype html><!-- the <head> goes here --><html><head>${SHIM_TAG}<script>boot()</script></head>`);
    expect(injectSandboxShim('<!doctype html><title>About <head></title><script>boot()</script></head>'))
      .toBe(`<!doctype html>${SHIM_TAG}<title>About <head></title><script>boot()</script></head>`);
    expect(injectSandboxShim('<!doctype html><html data-n="<head>"><head data-x="a>b"><script>boot()</script></head>'))
      .toBe(`<!doctype html><html data-n="<head>"><head data-x="a>b">${SHIM_TAG}<script>boot()</script></head>`);
  });

  test("ahead of a script that comes before <head>, and never inside one", () => {
    expect(injectSandboxShim('<!doctype html><script>boot()</script><head></head>'))
      .toBe(`<!doctype html>${SHIM_TAG}<script>boot()</script><head></head>`);
    expect(injectSandboxShim('<script>var t = "<head>";</script><p>x</p>'))
      .toBe(`${SHIM_TAG}<script>var t = "<head>";</script><p>x</p>`);
    expect(injectSandboxShim("<!doctype html><header>x</header>")).toBe(`<!doctype html>${SHIM_TAG}<header>x</header>`);
  });
});

describe("the bridge (hosts that load it by URL get the shim from it)", () => {
  // The bridge needs a DOM past its first lines; the shim runs before that, so what it left behind is read after the throw.
  const runBridge = (frame: ReturnType<typeof opaqueFrame>) => {
    try { frame.run(BRIDGE_SCRIPT); } catch {}
  };

  test("installs the shim in a sandboxed page", () => {
    const frame = opaqueFrame("about:srcdoc");
    runBridge(frame);
    frame.run(PROTOTYPE_BOOT);
    expect(frame.run("window.drawn.hash")).toBe("#state=C4&theme=light&vp=phone");
  });

  test("leaves a live app's own history and storage alone", () => {
    const parent = {};
    const frame = opaqueFrame("http://localhost:5173/", { __plannotatorLiveConfig: { token: "t", editorOrigins: [] }, parent, top: parent });
    runBridge(frame);
    expect(() => frame.run("localStorage.getItem('theme')")).toThrow("sandboxed");
    expect(frame.run("history.replaceState.plannotatorSandboxShim")).toBeUndefined();
  });
});
