import { describe, it, expect, mock, afterEach } from "bun:test";
import { createCookieProxy } from "./cookie-proxy";
import type { CookieProxy } from "./cookie-proxy";

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
