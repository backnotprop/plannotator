import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { getCallbackConfig, executeCallback, CallbackAction, parseReturnLink, RETURN_URL_MAX_LENGTH } from "./callback";

// --- getCallbackConfig ---

function loc(url: string): { search: string; hash: string } {
  const parsed = new URL(url);
  return { search: parsed.search, hash: parsed.hash };
}

describe("getCallbackConfig", () => {
  test("returns null when no cb/ct params", () => {
    expect(getCallbackConfig(loc("https://share.plannotator.ai/#abc123"))).toBeNull();
  });

  test("returns config with params before #", () => {
    const result = getCallbackConfig(
      loc("https://share.plannotator.ai/?cb=https%3A%2F%2Flocalhost%3A9456%2Fplannotator-cb&ct=tok-123#abc"),
    );
    expect(result).not.toBeNull();
    expect(result!.callbackUrl).toBe("https://localhost:9456/plannotator-cb");
    expect(result!.token).toBe("tok-123");
  });

  test("returns config with params after # fragment", () => {
    const result = getCallbackConfig(
      loc("https://share.plannotator.ai/#abc?cb=https%3A%2F%2Flocalhost%3A9456%2Fplannotator-cb&ct=tok-456"),
    );
    expect(result).not.toBeNull();
    expect(result!.callbackUrl).toBe("https://localhost:9456/plannotator-cb");
    expect(result!.token).toBe("tok-456");
  });

  test("returns null when only cb is present", () => {
    expect(
      getCallbackConfig(loc("https://share.plannotator.ai/?cb=https%3A%2F%2Flocalhost%3A9456%2Fcb")),
    ).toBeNull();
  });

  test("returns null when only ct is present", () => {
    expect(getCallbackConfig(loc("https://share.plannotator.ai/?ct=tok-789"))).toBeNull();
  });

  test("decodes encoded callback URL", () => {
    const encoded = encodeURIComponent("https://bot.internal/plannotator-cb");
    const result = getCallbackConfig(loc(`https://share.plannotator.ai/?cb=${encoded}&ct=tok-abc#hash`));
    expect(result!.callbackUrl).toBe("https://bot.internal/plannotator-cb");
  });

  test("returns null when params are empty strings", () => {
    expect(getCallbackConfig(loc("https://share.plannotator.ai/?cb=&ct="))).toBeNull();
  });

  test("partial params in hash — only cb, no ct", () => {
    expect(
      getCallbackConfig(loc("https://share.plannotator.ai/#abc?cb=https%3A%2F%2Flocalhost%3A9456%2Fcb")),
    ).toBeNull();
  });

  test("K8s cluster URL (http) is accepted", () => {
    const k8sUrl = "http://plannotator-cb.svc.cluster.local:9456/callback";
    const result = getCallbackConfig(
      loc(`https://share.plannotator.ai/?cb=${encodeURIComponent(k8sUrl)}&ct=k8s-tok-xyz`),
    );
    expect(result!.callbackUrl).toBe(k8sUrl);
    expect(result!.token).toBe("k8s-tok-xyz");
  });

  test("rejects non-http/https schemes", () => {
    expect(getCallbackConfig(loc(`https://share.plannotator.ai/?cb=${encodeURIComponent("file:///etc/passwd")}&ct=tok`))).toBeNull();
    expect(getCallbackConfig(loc(`https://share.plannotator.ai/?cb=${encodeURIComponent("javascript:alert(1)")}&ct=tok`))).toBeNull();
  });

  test("preserves percent-encoded chars in callback URL query params", () => {
    const presignedUrl =
      "https://s3.amazonaws.com/bucket/cb?X-Amz-Signature=abc%2Bdef%2Fghi%3D";
    const result = getCallbackConfig(
      loc(`https://share.plannotator.ai/?cb=${encodeURIComponent(presignedUrl)}&ct=tok-presigned`),
    );
    expect(result).not.toBeNull();
    expect(result!.callbackUrl).toBe(presignedUrl);
    expect(result!.token).toBe("tok-presigned");
  });

  test("rejects malformed URL", () => {
    expect(getCallbackConfig(loc(`https://share.plannotator.ai/?cb=not-a-url&ct=tok`))).toBeNull();
  });
});

// --- executeCallback ---

const mockConfig = { callbackUrl: "https://localhost:9456/plannotator-cb", token: "tok-test" };
const mockAnnotatedUrl = "https://share.plannotator.ai/#abc123";

let originalFetch: typeof globalThis.fetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

describe("executeCallback", () => {
  test("an answer whose body never ends still counts as sent, with no link", async () => {
    // The decision reached the bot on the 200. A stalled body must not hold the done screen.
    const stalled = new ReadableStream<Uint8Array>({ start() {} });
    globalThis.fetch = mock(async () => new Response(stalled, { status: 200 })) as any;
    const started = Date.now();
    const result = await executeCallback(CallbackAction.Approve, mockConfig, mockAnnotatedUrl, 50);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result?.type).toBe("success");
    expect((result as { returnLink?: unknown }).returnLink).toBeUndefined();
  });

  test("approve: 200 response returns success toast", async () => {
    globalThis.fetch = mock(async () => new Response("{}", { status: 200 })) as any;
    const result = await executeCallback(CallbackAction.Approve, mockConfig, mockAnnotatedUrl);
    expect(result?.type).toBe("success");
    expect(result?.message).toContain("approved");
  });

  test("feedback: 200 response returns success toast", async () => {
    globalThis.fetch = mock(async () => new Response("{}", { status: 200 })) as any;
    const result = await executeCallback(CallbackAction.Feedback, mockConfig, mockAnnotatedUrl);
    expect(result?.type).toBe("success");
    expect(result?.message).toContain("Feedback sent");
  });

  test("401 response returns expiry message", async () => {
    globalThis.fetch = mock(async () => new Response("{}", { status: 401 })) as any;
    const result = await executeCallback(CallbackAction.Approve, mockConfig, mockAnnotatedUrl);
    expect(result?.type).toBe("error");
    expect(result?.message).toContain("expired");
  });

  test("500 response returns generic failure message", async () => {
    globalThis.fetch = mock(async () => new Response("{}", { status: 500 })) as any;
    const result = await executeCallback(CallbackAction.Approve, mockConfig, mockAnnotatedUrl);
    expect(result?.type).toBe("error");
    expect(result?.message).toBe("Callback failed.");
  });

  test("network failure returns error toast", async () => {
    globalThis.fetch = mock(async () => { throw new Error("Network error"); }) as any;
    const result = await executeCallback(CallbackAction.Approve, mockConfig, mockAnnotatedUrl);
    expect(result?.type).toBe("error");
    expect(result?.message).toBe("Callback failed.");
  });

  test("2xx with an https return_url gives a link labeled with its host", async () => {
    const back = "https://github.com/owner/repo/issues/42";
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ return_url: back }), { status: 200 })) as any;
    const result = await executeCallback(CallbackAction.Approve, mockConfig, mockAnnotatedUrl);
    expect(result?.type).toBe("success");
    expect(result?.type === "success" ? result.returnLink : undefined).toEqual({ href: back, label: "Back to github.com" });
  });

  test("2xx with a return_url the link check refuses still counts as sent, with no link", async () => {
    for (const bad of ["javascript:alert(1)", "http://github.com/owner/repo/issues/42", "not a url", "", 42]) {
      globalThis.fetch = mock(async () => new Response(JSON.stringify({ return_url: bad }), { status: 200 })) as any;
      const result = await executeCallback(CallbackAction.Approve, mockConfig, mockAnnotatedUrl);
      expect(result?.type).toBe("success");
      expect(result?.type === "success" ? result.returnLink : "unexpected").toBeUndefined();
    }
  });

  test("2xx with an empty, non-JSON or field-less body still counts as sent, with no link", async () => {
    for (const body of [null, "ok", "[1]", "{}"]) {
      globalThis.fetch = mock(async () => new Response(body, { status: body === null ? 204 : 200 })) as any;
      const result = await executeCallback(CallbackAction.Feedback, mockConfig, mockAnnotatedUrl);
      expect(result?.type).toBe("success");
      expect(result?.type === "success" ? result.returnLink : "unexpected").toBeUndefined();
    }
  });

  test("a failed send gives no link even when the answer names one", async () => {
    for (const status of [401, 500]) {
      globalThis.fetch = mock(async () => new Response(JSON.stringify({ return_url: "https://github.com/o/r/issues/1" }), { status })) as any;
      const result = await executeCallback(CallbackAction.Approve, mockConfig, mockAnnotatedUrl);
      expect(result?.type).toBe("error");
      expect(result && "returnLink" in result).toBe(false);
    }
  });

  test("POSTs correct JSON body for approve", async () => {
    let capturedBody: string | null = null;
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return new Response("{}", { status: 200 });
    }) as any;
    await executeCallback(CallbackAction.Approve, mockConfig, mockAnnotatedUrl);
    const body = JSON.parse(capturedBody!);
    expect(body.action).toBe("approve");
    expect(body.token).toBe("tok-test");
    expect(body.annotated_url).toBe(mockAnnotatedUrl);
  });

  test("POSTs correct JSON body for feedback", async () => {
    let capturedBody: string | null = null;
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return new Response("{}", { status: 200 });
    }) as any;
    await executeCallback(CallbackAction.Feedback, mockConfig, mockAnnotatedUrl);
    const body = JSON.parse(capturedBody!);
    expect(body.action).toBe("feedback");
    expect(body.token).toBe("tok-test");
    expect(body.annotated_url).toBe(mockAnnotatedUrl);
  });
});

// --- parseReturnLink ---

describe("parseReturnLink", () => {
  test("an https address gives its parsed href and a label naming the parsed host", () => {
    expect(parseReturnLink("https://GitHub.com:8443/owner/repo/issues/42#top")).toEqual({
      href: "https://github.com:8443/owner/repo/issues/42#top",
      label: "Back to github.com",
    });
  });

  test("an internationalized host is labeled in its xn-- form, so a look-alike shows", () => {
    // "gіthub.com" with a Cyrillic "і": the label must not read "github.com".
    const link = parseReturnLink("https://g\u0456thub.com/owner/repo");
    expect(link?.label).toMatch(/^Back to xn--/);
    expect(link?.label).not.toBe("Back to github.com");
    expect(new URL(link!.href).hostname).toBe(link!.label.slice("Back to ".length));
  });

  test("refuses every scheme but https", () => {
    for (const raw of [
      "http://github.com/x",
      "javascript:alert(1)",
      "data:text/html,hi",
      "file:///etc/passwd",
      "ftp://example.com/x",
      "blob:https://example.com/1",
      "vbscript:msgbox(1)",
    ]) {
      expect(parseReturnLink(raw)).toBeUndefined();
    }
  });

  test("refuses an address carrying a user name or password", () => {
    for (const raw of [
      "https://user:pass@github.com/x",
      "https://user@github.com/x",
      "https://:pass@github.com/x",
      "https://github.com@evil.example/x",
    ]) {
      expect(parseReturnLink(raw)).toBeUndefined();
    }
  });

  test("refuses an address longer than the cap, keeps one at the cap", () => {
    const base = "https://github.com/";
    expect(parseReturnLink(base + "a".repeat(RETURN_URL_MAX_LENGTH - base.length))).toBeDefined();
    expect(parseReturnLink(base + "a".repeat(RETURN_URL_MAX_LENGTH - base.length + 1))).toBeUndefined();
  });

  test("refuses a malformed, empty or missing value", () => {
    for (const raw of ["not a url", "https://", "//github.com/x", "", undefined, null, 42, {}, ["https://github.com"]]) {
      expect(parseReturnLink(raw)).toBeUndefined();
    }
  });
});
