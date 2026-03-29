import { describe, test, expect, mock, beforeEach } from "bun:test";
import { executeCallback } from "./callbackHttp";

const mockConfig = {
  callbackUrl: "https://localhost:9456/plannotator-cb",
  token: "tok-test",
};

describe("executeCallback", () => {
  beforeEach(() => {
    // Reset fetch mock before each test
    (globalThis as any).fetch = undefined;
  });

  test("approve: 200 response returns success toast", async () => {
    globalThis.fetch = mock(async () => new Response("{}", { status: 200 })) as any;
    const result = await executeCallback("approve", mockConfig);
    expect(result?.type).toBe("success");
    expect(result?.message).toContain("approved");
  });

  test("feedback: 200 response returns success toast", async () => {
    globalThis.fetch = mock(async () => new Response("{}", { status: 200 })) as any;
    const result = await executeCallback("feedback", mockConfig);
    expect(result?.type).toBe("success");
    expect(result?.message).toContain("Feedback sent");
  });

  test("401 response returns expiry message", async () => {
    globalThis.fetch = mock(async () => new Response("{}", { status: 401 })) as any;
    const result = await executeCallback("approve", mockConfig);
    expect(result?.type).toBe("error");
    expect(result?.message).toContain("expired");
  });

  test("500 response returns generic failure message", async () => {
    globalThis.fetch = mock(async () => new Response("{}", { status: 500 })) as any;
    const result = await executeCallback("approve", mockConfig);
    expect(result?.type).toBe("error");
    expect(result?.message).toBe("Callback failed.");
  });

  test("network failure returns error toast", async () => {
    globalThis.fetch = mock(async () => { throw new Error("Network error"); }) as any;
    const result = await executeCallback("approve", mockConfig);
    expect(result?.type).toBe("error");
    expect(result?.message).toBe("Callback failed.");
  });

  test("POSTs correct JSON body for approve", async () => {
    let capturedBody: string | null = null;
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return new Response("{}", { status: 200 });
    }) as any;
    await executeCallback("approve", mockConfig);
    const body = JSON.parse(capturedBody!);
    expect(body.action).toBe("approve");
    expect(body.token).toBe("tok-test");
  });

  test("POSTs correct JSON body for feedback", async () => {
    let capturedBody: string | null = null;
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return new Response("{}", { status: 200 });
    }) as any;
    await executeCallback("feedback", mockConfig);
    const body = JSON.parse(capturedBody!);
    expect(body.action).toBe("feedback");
    expect(body.token).toBe("tok-test");
  });
});
