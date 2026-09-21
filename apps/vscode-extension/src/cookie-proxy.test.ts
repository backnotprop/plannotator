import { describe, it, expect, mock, afterEach } from "bun:test";
import {
  applyPanelCookieDefaults,
  createCookieProxy,
  PANEL_SEED_COOKIE,
  PANEL_SEED_VERSION,
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
      expect(html).toContain('window.addEventListener("keydown"');
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
