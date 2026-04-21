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
