import { afterEach, describe, expect, test } from "bun:test";
import { bypassProxyForLoopback, directFetchInit, withLoopbackNoProxy } from "./loopback-proxy";

describe("withLoopbackNoProxy", () => {
  test("adds the loopback names to an empty value", () => {
    expect(withLoopbackNoProxy(undefined)).toBe("127.0.0.1,localhost,::1");
    expect(withLoopbackNoProxy("")).toBe("127.0.0.1,localhost,::1");
  });

  test("keeps existing entries first and in order", () => {
    expect(withLoopbackNoProxy("corp.example,.internal")).toBe("corp.example,.internal,127.0.0.1,localhost,::1");
  });

  test("adds no name already present, whatever its case or spacing", () => {
    expect(withLoopbackNoProxy(" LOCALHOST , 127.0.0.1")).toBe("LOCALHOST,127.0.0.1,::1");
    expect(withLoopbackNoProxy("*")).toBe("*,127.0.0.1,localhost,::1");
  });

  test("is idempotent", () => {
    const once = withLoopbackNoProxy("corp.example");
    expect(withLoopbackNoProxy(once)).toBe(once);
  });
});

describe("bypassProxyForLoopback", () => {
  test("sets both spellings when neither is set", () => {
    const env: Record<string, string | undefined> = {};
    bypassProxyForLoopback(env);
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost,::1");
    expect(env.no_proxy).toBe("127.0.0.1,localhost,::1");
  });

  test("copies the one set spelling's entries into the other", () => {
    const upperOnly: Record<string, string | undefined> = { NO_PROXY: "corp.example" };
    bypassProxyForLoopback(upperOnly);
    expect(upperOnly.no_proxy).toBe("corp.example,127.0.0.1,localhost,::1");
    expect(upperOnly.NO_PROXY).toBe("corp.example,127.0.0.1,localhost,::1");

    const lowerOnly: Record<string, string | undefined> = { no_proxy: "corp.example" };
    bypassProxyForLoopback(lowerOnly);
    expect(lowerOnly.NO_PROXY).toBe("corp.example,127.0.0.1,localhost,::1");
  });

  test("keeps each spelling's own entries when both are set", () => {
    const env: Record<string, string | undefined> = { NO_PROXY: "a.example", no_proxy: "b.example,localhost" };
    bypassProxyForLoopback(env);
    expect(env.NO_PROXY).toBe("a.example,127.0.0.1,localhost,::1");
    expect(env.no_proxy).toBe("b.example,localhost,127.0.0.1,::1");
  });
});

describe("a loopback fetch with a proxy in the environment", () => {
  const PROXY_KEYS = ["http_proxy", "HTTP_PROXY", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"] as const;
  const saved = Object.fromEntries(PROXY_KEYS.map((key) => [key, process.env[key]]));
  let server: ReturnType<typeof Bun.serve> | null = null;

  afterEach(() => {
    server?.stop(true);
    server = null;
    for (const key of PROXY_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  // Port 9 (discard) on loopback: nothing listens, so a request sent to this
  // "proxy" is refused instead of reaching the server.
  function startWithDeadProxy(): string {
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    for (const key of PROXY_KEYS) delete process.env[key];
    process.env.http_proxy = "http://127.0.0.1:9";
    return `http://127.0.0.1:${server.port}/`;
  }

  async function answer(url: string, init?: RequestInit): Promise<string> {
    try {
      return await (await fetch(url, init)).text();
    } catch {
      return "refused";
    }
  }

  test("goes to the proxy (and fails) without the fix", async () => {
    const url = startWithDeadProxy();
    expect(await answer(url)).toBe("refused");
  });

  test("reaches the server once the loopback names are in NO_PROXY", async () => {
    const url = startWithDeadProxy();
    bypassProxyForLoopback(process.env);
    expect(await answer(url)).toBe("ok");
    expect(await answer(url.replace("127.0.0.1", "localhost"))).toBe("ok");
  });

  test("reaches the server with directFetchInit and no NO_PROXY", async () => {
    const url = startWithDeadProxy();
    expect(await answer(url, directFetchInit({ method: "GET" }))).toBe("ok");
  });
});
