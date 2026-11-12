import { test, expect, mock, beforeEach, afterEach } from "bun:test";
import { urlToMarkdown } from "./url-to-markdown";

let fetchCalls: { url: string; headers: Record<string, string> }[] = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

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
  expect(fetchCalls).toHaveLength(1);
  expect(fetchCalls[0].headers.Accept).toContain("text/markdown");
});

test("content negotiation: falls through to Jina when server returns HTML", async () => {
  let callCount = 0;
  globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    fetchCalls.push({ url: String(url), headers: headers ?? {} });
    callCount++;

    if (callCount === 1) {
      return Promise.resolve(
        new Response("<html><body>Hi</body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
    }
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
      return Promise.resolve(new Response(null, { status: 500 }));
    }
    return Promise.resolve(
      new Response("# Jina fallback", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
  }) as typeof fetch;

  const result = await urlToMarkdown("https://example.com/page", { useJina: true });

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
