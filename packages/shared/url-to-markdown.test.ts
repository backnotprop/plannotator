import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { urlToMarkdown } from "./url-to-markdown";

// Track fetch calls to verify headers and URL selection
let fetchCalls: { url: string; headers: Record<string, string> }[] = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Create a mock fetch that responds based on the Accept header.
 * When Accept includes text/markdown, returns markdown with the right content-type.
 * Otherwise returns HTML.
 */
function mockFetchWithMarkdownSupport(markdown: string) {
  return mock((url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    fetchCalls.push({ url: String(url), headers: headers ?? {} });

    const accept = headers?.Accept || headers?.accept || "";
    if (accept.includes("text/markdown")) {
      return Promise.resolve(
        new Response(markdown, {
          status: 200,
          headers: {
            "content-type": "text/markdown; charset=utf-8",
            "x-markdown-tokens": "42",
          },
        }),
      );
    }
    return Promise.resolve(
      new Response("<html><body><p>Hello</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
  });
}

/** Mock fetch that only returns HTML (no markdown support). */
function mockFetchHtmlOnly(html = "<html><body><p>Fallback</p></body></html>") {
  return mock((url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    fetchCalls.push({ url: String(url), headers: headers ?? {} });
    return Promise.resolve(
      new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
  });
}

test("content negotiation: uses markdown when server supports it", async () => {
  const md = "# Hello\n\nThis is markdown from the server.";
  globalThis.fetch = mockFetchWithMarkdownSupport(md) as typeof fetch;

  const result = await urlToMarkdown("https://example.com/page", { useJina: true });

  expect(result.source).toBe("content-negotiation");
  expect(result.markdown).toBe(md);
  // Should only make one fetch (the content negotiation request)
  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0].headers.Accept).toContain("text/markdown");
});

test("content negotiation: falls through to Jina when server returns HTML", async () => {
  // First call (content negotiation) returns HTML, second (Jina) returns markdown
  let callCount = 0;
  globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    fetchCalls.push({ url: String(url), headers: headers ?? {} });
    callCount++;

    if (callCount === 1) {
      // Content negotiation attempt — server doesn't support it
      return Promise.resolve(
        new Response("<html><body>Hi</body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
    }
    // Jina Reader call
    return Promise.resolve(
      new Response("# From Jina", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
  }) as typeof fetch;

  const result = await urlToMarkdown("https://example.com/page", { useJina: true });

  expect(result.source).toBe("jina");
  expect(result.markdown).toBe("# From Jina");
  // Content negotiation fetch + Jina fetch
  expect(fetchCalls.length).toBeGreaterThanOrEqual(2);
  expect(fetchCalls[1].url).toContain("r.jina.ai");
});

test("content negotiation: skipped for local URLs", async () => {
  let callCount = 0;
  globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    fetchCalls.push({ url: String(_url), headers: headers ?? {} });
    callCount++;
    return Promise.resolve(
      new Response("<html><body>Local</body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
  }) as typeof fetch;

  const result = await urlToMarkdown("http://localhost:3000/readme", { useJina: false });

  expect(result.source).toBe("fetch+turndown");
  // No content negotiation request should have been made
  // (first call should be the Turndown fetch, not a markdown request)
  for (const call of fetchCalls) {
    if (call.headers.Accept) {
      expect(call.headers.Accept).not.toContain("text/markdown");
    }
  }
});

test("content negotiation: handles server error gracefully", async () => {
  let callCount = 0;
  globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    fetchCalls.push({ url: String(_url), headers: headers ?? {} });
    callCount++;

    if (callCount === 1) {
      // Content negotiation — server error
      return Promise.resolve(new Response(null, { status: 500 }));
    }
    // Jina fallback
    return Promise.resolve(
      new Response("# Jina fallback", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
  }) as typeof fetch;

  const result = await urlToMarkdown("https://example.com/page", { useJina: true });

  // Should fall through to Jina
  expect(result.source).toBe("jina");
});

test("raw .md URL: still takes priority over content negotiation", async () => {
  globalThis.fetch = mock((_url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    fetchCalls.push({ url: String(_url), headers: headers ?? {} });
    return Promise.resolve(
      new Response("# Raw markdown file", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );
  }) as typeof fetch;

  const result = await urlToMarkdown("https://example.com/README.md", { useJina: true });

  expect(result.source).toBe("fetch-raw");
  expect(result.markdown).toBe("# Raw markdown file");
});

// A local URL the person asked for may redirect within its own origin (a
// directory's trailing-slash 301, a renamed file), but never to another local
// origin; a public URL may never redirect to a local one.
test("local URL: follows a same-origin redirect, refuses one to another local origin", async () => {
  const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<p>Other</p>", { headers: { "content-type": "text/html" } }) });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/docs") return new Response(null, { status: 301, headers: { location: "/docs/" } });
      if (pathname === "/docs/") return new Response("<h1>Docs</h1><p>Hello</p>", { headers: { "content-type": "text/html" } });
      if (pathname === "/notes.md") return new Response(null, { status: 302, headers: { location: "/notes-v2.md" } });
      if (pathname === "/notes-v2.md") return new Response("# Notes\n", { headers: { "content-type": "text/plain" } });
      if (pathname === "/elsewhere") return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${other.port}/` } });
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;

    const docs = await urlToMarkdown(`${base}/docs`, { useJina: false });
    expect(docs.source).toBe("fetch+turndown");
    expect(docs.markdown).toContain("Hello");

    const notes = await urlToMarkdown(`${base}/notes.md`, { useJina: false });
    expect(notes.source).toBe("fetch-raw");
    expect(notes.markdown).toBe("# Notes\n");

    await expect(urlToMarkdown(`${base}/elsewhere`, { useJina: false })).rejects.toThrow("Redirect to private/local URL blocked");
  } finally {
    server.stop(true);
    other.stop(true);
  }
});

test("public URL: a redirect to a local host is still refused", async () => {
  globalThis.fetch = mock((url: string | URL | Request) => {
    fetchCalls.push({ url: String(url), headers: {} });
    return Promise.resolve(new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } }));
  }) as typeof fetch;

  await expect(urlToMarkdown("https://example.com/page", { useJina: false })).rejects.toThrow(
    "Redirect to private/local URL blocked: http://127.0.0.1/admin",
  );
  expect(fetchCalls.some((call) => call.url.startsWith("http://127.0.0.1"))).toBe(false);
});
