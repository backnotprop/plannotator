import { describe, it, expect, mock, afterEach } from "bun:test";
import {
  applyPanelCookieDefaults,
  createCookieProxy,
  KEY_BRIDGE_SOURCE,
  PANEL_SEED_COOKIE,
  PANEL_SEED_VERSION,
  upstreamConnectOptions,
} from "./cookie-proxy";
import type { CookieProxy } from "./cookie-proxy";

describe("applyPanelCookieDefaults", () => {
  it("seeds System mode for a panel that has never stored one", () => {
    // Plannotator's own default is Dark; inside VS Code the panel should follow
    // the IDE instead, which is what System resolves to there (issue #1053).
    expect(applyPanelCookieDefaults({})["plannotator-theme"]).toBe("system");
  });

  it("never overwrites a mode the user already chose", () => {
    const seeded = applyPanelCookieDefaults({ "plannotator-theme": "light" });
    expect(seeded["plannotator-theme"]).toBe("light");
  });

  it("keeps stored cookies and the auto-close flag", () => {
    const seeded = applyPanelCookieDefaults({ "plannotator-identity": "tater-42" });
    expect(seeded["plannotator-identity"]).toBe("tater-42");
    expect(seeded["plannotator-auto-close"]).toBe("true");
  });
});

describe("applyPanelCookieDefaults: legacy auto-seeded mode", () => {
  /**
   * What a panel opened before the seeding rules existed carries: the app
   * persisted the mode it resolved on first mount, and its default is Dark.
   * The user never chose it, and nothing in the store says so.
   */
  const legacyStore = {
    "plannotator-identity": "tater-42",
    "plannotator-theme": "dark",
    "plannotator-dark-theme": "plannotator",
  };

  it("re-seeds a legacy dark store to System so the panel follows the IDE again", () => {
    const seeded = applyPanelCookieDefaults(legacyStore);
    expect(seeded["plannotator-theme"]).toBe("system");
    // Only the mode is reconsidered; the rest of the store is untouched.
    expect(seeded["plannotator-identity"]).toBe("tater-42");
    expect(seeded["plannotator-dark-theme"]).toBe("plannotator");
  });

  it("marks every store it touches, fresh or legacy", () => {
    expect(applyPanelCookieDefaults({})[PANEL_SEED_COOKIE]).toBe(PANEL_SEED_VERSION);
    expect(applyPanelCookieDefaults(legacyStore)[PANEL_SEED_COOKIE]).toBe(PANEL_SEED_VERSION);
  });

  it("leaves Dark alone once the store has been marked", () => {
    // The case that must never be clobbered: a Dark the user picked after the
    // migration already ran. The marker is what tells the two apart.
    const chosen = applyPanelCookieDefaults({
      ...legacyStore,
      [PANEL_SEED_COOKIE]: PANEL_SEED_VERSION,
    });
    expect(chosen["plannotator-theme"]).toBe("dark");
  });

  it("runs at most once: re-seeded, then Dark chosen, then left alone", () => {
    // The store as it round-trips: seeded jar -> page -> globalState -> jar.
    const migrated = applyPanelCookieDefaults(legacyStore);
    expect(migrated["plannotator-theme"]).toBe("system");

    const afterUserPicksDark = { ...migrated, "plannotator-theme": "dark" };
    expect(applyPanelCookieDefaults(afterUserPicksDark)["plannotator-theme"]).toBe("dark");
  });

  it("never re-seeds a mode the auto-seed could not have written", () => {
    // Dark is the app's default and always has been, so Light and System are
    // choices no matter how old the store is.
    for (const mode of ["light", "system"]) {
      const seeded = applyPanelCookieDefaults({ ...legacyStore, "plannotator-theme": mode });
      expect(seeded["plannotator-theme"]).toBe(mode);
    }
  });
});

describe("createCookieProxy", () => {
  let proxy: CookieProxy | undefined;

  afterEach(() => {
    proxy?.server.close();
    proxy = undefined;
  });

  it("starts on a random port", async () => {
    proxy = await createCookieProxy({
      loadCookies: () => "",
      onSaveCookies: () => {},
    });
    expect(proxy.port).toBeGreaterThan(0);
  });

  it("saves cookies via POST /___ext/cookies", async () => {
    const onSave = mock((_: string) => {});
    proxy = await createCookieProxy({
      loadCookies: () => "",
      onSaveCookies: onSave,
    });

    const res = await fetch(
      `http://127.0.0.1:${proxy.port}/___ext/cookies`,
      { method: "POST", body: "plannotator-identity=tater-123; plannotator-save-enabled=true" },
    );

    expect(res.status).toBe(200);
    expect(onSave).toHaveBeenCalledWith(
      "plannotator-identity=tater-123; plannotator-save-enabled=true",
    );
  });

  it("emits close event on POST /___ext/close", async () => {
    proxy = await createCookieProxy({
      loadCookies: () => "",
      onSaveCookies: () => {},
    });

    const onClose = mock(() => {});
    proxy.events.on("close", onClose);

    const res = await fetch(
      `http://127.0.0.1:${proxy.port}/___ext/close`,
      { method: "POST" },
    );

    expect(res.status).toBe(200);
    expect(onClose).toHaveBeenCalled();
  });

  it("returns 502 when no upstream is configured", async () => {
    proxy = await createCookieProxy({
      loadCookies: () => "",
      onSaveCookies: () => {},
    });

    const res = await fetch(`http://127.0.0.1:${proxy.port}/some-path`);
    expect(res.status).toBe(502);
  });

  it("rewrites URL and sets upstream", async () => {
    proxy = await createCookieProxy({
      loadCookies: () => "",
      onSaveCookies: () => {},
    });

    const rewritten = proxy.rewriteUrl("http://localhost:3000/review?id=42");
    expect(rewritten).toBe(
      `http://127.0.0.1:${proxy.port}/review?id=42`,
    );
  });

  it("proxies requests to upstream and injects script into HTML", async () => {
    // Start a simple upstream server
    const { createServer } = await import("http");
    const upstream = createServer((_, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><title>Test</title></head><body>Hello</body></html>");
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const upstreamPort = (upstream.address() as { port: number }).port;

    try {
      proxy = await createCookieProxy({
        loadCookies: () => "plannotator-identity=tater-42; other-cookie=ignore",
        onSaveCookies: () => {},
      });

      // Set upstream by rewriting a URL
      const url = proxy.rewriteUrl(`http://127.0.0.1:${upstreamPort}/`);
      const res = await fetch(url);
      const html = await res.text();

      // Should contain the injected script
      expect(html).toContain("/___ext/cookies");
      expect(html).toContain("/___ext/close");
      // Should contain the virtual cookie store with saved cookies
      expect(html).toContain('"plannotator-identity":"tater-42"');
      expect(html).toContain('"other-cookie":"ignore"');
      // Should forward keystrokes to the parent for VS Code keybindings
      expect(html).toContain('type:"plannotator-keydown"');
      expect(html).toContain("var keyBridge=(" + KEY_BRIDGE_SOURCE + ")(window,document,");
      // Should still contain original content
      expect(html).toContain("<title>Test</title>");
      expect(html).toContain("Hello");
    } finally {
      upstream.close();
    }
  });

  it("passes through non-HTML responses without modification", async () => {
    const { createServer } = await import("http");
    const upstream = createServer((_, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":"ok"}');
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const upstreamPort = (upstream.address() as { port: number }).port;

    try {
      proxy = await createCookieProxy({
        loadCookies: () => "plannotator-identity=tater-42",
        onSaveCookies: () => {},
      });

      const url = proxy.rewriteUrl(`http://127.0.0.1:${upstreamPort}/api/plan`);
      const res = await fetch(url);
      const body = await res.json();

      expect(body).toEqual({ status: "ok" });
    } finally {
      upstream.close();
    }
  });
});

describe("the upstream connection for a localhost subdomain (#2184)", () => {
  let proxy: CookieProxy | undefined;
  afterEach(() => {
    proxy?.server.close();
    proxy = undefined;
  });

  it("connects a *.localhost upstream to 127.0.0.1 and keeps its Host", async () => {
    const { createServer } = await import("http");
    let seenHost: string | undefined;
    const upstream = createServer((req, res) => {
      seenHost = req.headers.host;
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as { port: number }).port;
    try {
      proxy = await createCookieProxy({ loadCookies: () => "", onSaveCookies: () => {} });
      // A name no resolver needs to know: the pinned address reaches the upstream.
      const res = await fetch(proxy.rewriteUrl(`http://pn-proxy-test-2184.localhost:${upstreamPort}/api/plan`));
      expect(await res.json()).toEqual({ ok: true });
      expect(seenHost).toBe(`pn-proxy-test-2184.localhost:${upstreamPort}`);
    } finally {
      upstream.close();
    }
  });

  it("pins only a localhost subdomain; plain localhost and other names resolve as before", () => {
    expect(upstreamConnectOptions("plannotator.localhost")).toEqual({ hostname: "127.0.0.1" });
    for (const name of ["localhost", "127.0.0.1", ".localhost", "example.com", "localhost.example.com"]) {
      expect(upstreamConnectOptions(name)).toEqual({});
    }
    });
});

/**
 * The key forwarder runs in the proxied page. Here it is evaluated from the
 * same source string and installed on a stand-in window: a plain EventTarget
 * (this suite runs without DOM globals), so the test process's own globals are
 * never touched. Keyboard events are plain cancelable Events carrying the
 * fields the forwarder reads.
 */
describe("KEY_BRIDGE_SOURCE: forwarding only keys the page did not take", () => {
  type Posted = { type: string; event?: { key: string; metaKey: boolean } };

  function install() {
    const win = new EventTarget() as EventTarget & {
      getSelection: () => { toString(): string };
    };
    let selection = "";
    win.getSelection = () => ({ toString: () => selection });
    const commands: string[] = [];
    const doc = {
      activeElement: null as Element | null,
      execCommand: (name: string) => {
        commands.push(name);
        return true;
      },
    };
    const posted: Posted[] = [];
    const bridge = new Function(`return (${KEY_BRIDGE_SOURCE})`)()(
      win,
      doc,
      (msg: Posted) => posted.push(msg),
    );
    return {
      win,
      bridge,
      posted,
      commands,
      setSelection: (s: string) => {
        selection = s;
      },
      press(init: Partial<Record<"key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey", unknown>>) {
        const ev = keydown(init);
        win.dispatchEvent(ev);
        return ev;
      },
    };
  }

  function keydown(init: Record<string, unknown>) {
    return Object.assign(new Event("keydown", { cancelable: true }), {
      key: "", code: "", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
      ...init,
    }) as Event & { key: string; metaKey: boolean };
  }

  /** One task later: when the forwarder decides. */
  const afterDispatch = () => new Promise((r) => setTimeout(r, 0));
  const keydowns = (posted: Posted[]) => posted.filter((m) => m.type === "plannotator-keydown");

  it("does not forward a key the app took (the ⌘B / ⌘. / ⌘⇧G double action)", async () => {
    const t = install();
    // The app's listener is registered after the forwarder, as the review
    // app's window listeners are (the forwarder runs from <head>).
    t.win.addEventListener("keydown", (e) => {
      const ev = e as Event & { key: string; metaKey: boolean };
      const k = ev.key.toLowerCase();
      if (ev.metaKey && (k === "b" || k === "." || k === "g")) e.preventDefault();
    });
    t.press({ key: "b", metaKey: true });
    t.press({ key: ".", metaKey: true });
    t.press({ key: "G", metaKey: true, shiftKey: true });
    await afterDispatch();
    expect(keydowns(t.posted)).toEqual([]);
  });

  it("still forwards a key nothing on the page took", async () => {
    const t = install();
    t.win.addEventListener("keydown", () => {});
    t.press({ key: "p", metaKey: true, shiftKey: true, code: "KeyP" });
    expect(keydowns(t.posted)).toEqual([]); // not before the event finished
    await afterDispatch();
    const sent = keydowns(t.posted);
    expect(sent).toHaveLength(1);
    expect(sent[0].event).toMatchObject({ key: "p", code: "KeyP", metaKey: true, shiftKey: true });
  });

  it("always forwards VS Code's window keys (Quick Open, Command Palette, close and switch editor), even when the page took them", async () => {
    const t = install();
    t.win.addEventListener("keydown", (e) => e.preventDefault());
    t.press({ key: "p", metaKey: true, code: "KeyP" });
    t.press({ key: "P", metaKey: true, shiftKey: true, code: "KeyP" });
    t.press({ key: "p", ctrlKey: true, code: "KeyP" });
    t.press({ key: "w", metaKey: true, code: "KeyW" });
    t.press({ key: "Tab", ctrlKey: true, code: "Tab" });
    t.press({ key: "Tab", ctrlKey: true, shiftKey: true, code: "Tab" });
    // Not on the list: the page took them, so VS Code does not get them.
    t.press({ key: "e", metaKey: true, code: "KeyE" });
    t.press({ key: "F", metaKey: true, shiftKey: true, code: "KeyF" });
    t.press({ key: "W", metaKey: true, shiftKey: true, code: "KeyW" });
    await afterDispatch();
    expect(keydowns(t.posted).map((m) => m.event!.key)).toEqual(["p", "P", "p", "w", "Tab", "Tab"]);
  });

  it("decides on what the page did during dispatch, not before it", async () => {
    const t = install();
    // A listener that decides late in the same dispatch still counts.
    t.win.addEventListener("keydown", (e) => {
      queueMicrotask(() => {});
      e.preventDefault();
    });
    t.press({ key: "k", ctrlKey: true });
    await afterDispatch();
    expect(keydowns(t.posted)).toEqual([]);
  });

  it("copy with a selection goes through the clipboard bridge and is not forwarded", async () => {
    const t = install();
    t.setSelection("selected text");
    const ev = t.press({ key: "c", metaKey: true });
    expect(ev.defaultPrevented).toBe(true);
    const cut = t.press({ key: "x", metaKey: true });
    expect(cut.defaultPrevented).toBe(true);
    await afterDispatch();
    expect(t.posted.filter((m) => m.type === "plannotator-clipboard-write")).toHaveLength(2);
    expect(t.commands).toEqual(["delete"]);
    expect(keydowns(t.posted)).toEqual([]);
  });

  it("copy with nothing selected is left alone and not forwarded", async () => {
    const t = install();
    const ev = t.press({ key: "c", metaKey: true });
    expect(ev.defaultPrevented).toBe(false);
    await afterDispatch();
    expect(t.posted).toEqual([]);
  });

  it("paste reads through the bridge", async () => {
    const t = install();
    const ev = t.press({ key: "v", ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true);
    const req = t.posted.find((m) => m.type === "plannotator-clipboard-read") as { id: number } | undefined;
    expect(req).toBeDefined();
    t.win.dispatchEvent(
      Object.assign(new Event("message"), { data: { type: "plannotator-clipboard-data", id: req!.id, text: "pasted" } }),
    );
    await afterDispatch();
    expect(t.commands).toEqual(["insertText"]);
    expect(keydowns(t.posted)).toEqual([]);
  });

  it("select-all, undo and redo stay native: not prevented, not forwarded", async () => {
    const t = install();
    for (const key of ["a", "z", "y"]) {
      expect(t.press({ key, metaKey: true }).defaultPrevented).toBe(false);
      expect(t.press({ key, ctrlKey: true }).defaultPrevented).toBe(false);
    }
    await afterDispatch();
    expect(t.posted).toEqual([]);
  });
});
