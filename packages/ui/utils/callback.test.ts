import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { getCallbackConfig, executeCallback, CallbackAction } from "./callback";

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
