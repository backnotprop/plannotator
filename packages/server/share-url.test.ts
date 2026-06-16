import { describe, expect, mock, test } from "bun:test";
import { decompress } from "@plannotator/shared/compress";
import { generateRemoteShareUrl, writeRemoteShareLink } from "./share-url";

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
