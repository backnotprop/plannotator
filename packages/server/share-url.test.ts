import { afterEach, describe, expect, mock, test } from "bun:test";
import { decompress } from "@plannotator/shared/compress";
import { generateRemoteShareUrl, prepareRemoteShareLink, writeRemoteShareLink } from "./share-url";
import { resetServerUrlHostnameCache } from "./remote";

const shareEnvKeys = ["PLANNOTATOR_HOSTNAME", "PLANNOTATOR_REMOTE", "CLAUDE_HOOKS_NTFY_URL", "CLAUDE_HOOKS_NTFY_TOKEN"];
const savedShareEnv: Record<string, string | undefined> = {};

function clearShareEnv() {
  for (const key of shareEnvKeys) {
    savedShareEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetServerUrlHostnameCache();
}

afterEach(() => {
  for (const key of shareEnvKeys) {
    if (savedShareEnv[key] !== undefined) process.env[key] = savedShareEnv[key];
    else delete process.env[key];
  }
  resetServerUrlHostnameCache();
});

describe("prepareRemoteShareLink", () => {
  test("rewrites the local host to the resolved hostname for a directly-reachable link", async () => {
    clearShareEnv();
    process.env.PLANNOTATOR_HOSTNAME = "mybox.ts.net";

    const link = await prepareRemoteShareLink("# Plan", "https://share.example.test", "review the plan", "plan only", {
      serverUrl: "http://localhost:45231",
    });

    expect(link.kind).toBe("reachable");
    expect(link.url).toBe("http://mybox.ts.net:45231");
    expect(link.descriptor).toContain("full review with approve/deny");
    expect(link.ntfyOk).toBe(false);
  });

  test("falls back to a read-only share link when no reachable hostname is available", async () => {
    clearShareEnv();
    // Force non-remote so Tailscale detection is skipped and the host resolves
    // to "localhost" (the box running the suite may itself be on a tailnet).
    process.env.PLANNOTATOR_REMOTE = "0";
    resetServerUrlHostnameCache();

    const link = await prepareRemoteShareLink("# Plan", "https://share.example.test", "review the plan", "plan only", {
      serverUrl: "http://localhost:45231",
    });

    expect(link.kind).toBe("share");
    expect(link.url.startsWith("https://share.example.test/#")).toBe(true);
    expect(link.descriptor).toContain("read-only");
  });

  test("sends an ntfy push for the reachable link via the injected fetch", async () => {
    clearShareEnv();
    process.env.PLANNOTATOR_HOSTNAME = "mybox.ts.net";
    process.env.CLAUDE_HOOKS_NTFY_URL = "https://ntfy.example.test/mytopic";

    const fetchImpl = mock(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://ntfy.example.test/mytopic");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Title).toBe("Plannotator: review the plan");
      expect(headers.Click).toBe("http://mybox.ts.net:45231");
      expect(String(init?.body)).toBe("http://mybox.ts.net:45231");
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const link = await prepareRemoteShareLink("# Plan", "https://share.example.test", "review the plan", "plan only", {
      serverUrl: "http://localhost:45231",
      fetchImpl,
    });

    expect(link.ntfyOk).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("generateRemoteShareUrl", () => {
  test("keeps markdown remote shares hash-based", async () => {
    const url = await generateRemoteShareUrl("# Plan", "https://share.example.test");
    expect(url.startsWith("https://share.example.test/#")).toBe(true);

    const payload = await decompress(url.split("#")[1]) as { p: string; a: unknown[] };
    expect(payload).toEqual({ p: "# Plan", a: [] });
  });

  test("uses encrypted paste links for raw HTML remote shares", async () => {
    const fetchImpl = mock(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://paste.example.test/api/paste");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ "Content-Type": "application/json" });
      const body = JSON.parse(String(init?.body)) as { data?: unknown };
      expect(typeof body.data).toBe("string");
      return new Response(JSON.stringify({ id: "abc123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const url = await generateRemoteShareUrl("", "https://share.example.test", {
      rawHtml: "<!doctype html><h1>Hello</h1>",
      pasteApiUrl: "https://paste.example.test",
      fetchImpl,
    });

    expect(url).toMatch(/^https:\/\/share\.example\.test\/p\/abc123#key=[A-Za-z0-9_-]+&paste=/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("warns instead of silently dropping raw HTML remote share failures", async () => {
    const fetchImpl = mock(async () =>
      new Response(JSON.stringify({ error: "Payload too large (max 5 MB encrypted)" }), {
        status: 413,
        headers: { "Content-Type": "application/json" },
      })
    ) as typeof fetch;
    const originalWrite = process.stderr.write;
    let stderr = "";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      await writeRemoteShareLink("", "https://share.example.test", "annotate", "HTML document only", {
        rawHtml: "<!doctype html><h1>Hello</h1>",
        pasteApiUrl: "https://paste.example.test",
        fetchImpl,
      });
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(stderr).toContain("Warning: could not create remote share link for HTML document only.");
    expect(stderr).toContain("Payload too large (max 5 MB encrypted)");
    expect(stderr).toContain("HTML sharing uses the paste service");
  });
});
