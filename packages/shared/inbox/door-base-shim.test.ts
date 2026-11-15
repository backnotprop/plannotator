import { describe, expect, test } from "bun:test";
import { injectDoorBase } from "./door-base-shim";

const BASE = "/s/aaaaaaaaaaaaaaaaaaaaaa";

function runShim(html: string) {
  const script = /<script data-plannotator-door>([\s\S]*?)<\/script>/.exec(html)![1]!;
  const seen: string[] = [];
  class FakeEventSource {
    constructor(public url: string) {
      seen.push(`es ${url}`);
    }
  }
  class FakeWebSocket {
    static OPEN = 1;
    constructor(public url: string) {
      seen.push(`ws ${url}`);
    }
  }
  class FakeXhr {
    open(method: string, url: string) {
      seen.push(`xhr ${method} ${url}`);
    }
  }
  const window: Record<string, unknown> = {
    location: { href: `https://inbox.example.test${BASE}/`, host: "inbox.example.test", protocol: "https:" },
    fetch: (input: unknown) => {
      seen.push(`fetch ${input instanceof Request ? input.url : String(input)}`);
      return Promise.resolve(new Response(null));
    },
    Request,
    EventSource: FakeEventSource,
    WebSocket: FakeWebSocket,
    XMLHttpRequest: FakeXhr,
    navigator: { sendBeacon: (url: string) => (seen.push(`beacon ${url}`), true) },
  };
  new Function("window", "URL", script)(window, URL);
  return { window: window as any, seen };
}

describe("the door's base for a session page", () => {
  test("root-absolute scripts and styles in the page point under the session", () => {
    const html = '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-1.js"></script><link rel="stylesheet" href="/assets/a.css"><link rel="icon" href="//cdn.example/x.png"></head><body><a href="/keep">x</a></body></html>';
    const out = injectDoorBase(html, BASE);
    expect(out).toContain(`src="${BASE}/assets/index-1.js"`);
    expect(out).toContain(`href="${BASE}/assets/a.css"`);
    expect(out).toContain('href="//cdn.example/x.png"');
    expect(out).toContain('<a href="/keep">');
    expect(out.indexOf("data-plannotator-door")).toBeLessThan(out.indexOf("index-1.js"));
  });

  test("fetch, XMLHttpRequest, EventSource, WebSocket and sendBeacon go under the session", async () => {
    const { window, seen } = runShim(injectDoorBase("<html><head></head></html>", BASE));
    await window.fetch("/api/diff");
    await window.fetch(`${BASE}/api/already`);
    await window.fetch("https://inbox.example.test/api/abs");
    await window.fetch("https://other.example.test/api/x");
    await window.fetch(new Request("https://inbox.example.test/api/req", { method: "POST", body: "x" }));
    await window.fetch("relative/thing");
    new window.XMLHttpRequest().open("GET", "/api/xhr");
    new window.EventSource("/api/stream");
    new window.WebSocket("wss://inbox.example.test/api/ws");
    window.navigator.sendBeacon("/api/beacon");
    expect(seen).toEqual([
      `fetch ${BASE}/api/diff`,
      `fetch ${BASE}/api/already`,
      `fetch https://inbox.example.test${BASE}/api/abs`,
      "fetch https://other.example.test/api/x",
      `fetch https://inbox.example.test${BASE}/api/req`,
      "fetch relative/thing",
      `xhr GET ${BASE}/api/xhr`,
      `es ${BASE}/api/stream`,
      `ws wss://inbox.example.test${BASE}/api/ws`,
      `beacon ${BASE}/api/beacon`,
    ]);
    expect(new window.EventSource("/x")).toBeInstanceOf(window.EventSource);
    expect(window.WebSocket.OPEN).toBe(1);
  });
});
