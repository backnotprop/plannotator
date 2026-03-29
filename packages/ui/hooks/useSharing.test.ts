import { describe, test, expect } from "bun:test";
import { getCallbackConfig } from "./useSharing";
import { isSome, isNone } from "../utils/option";

/**
 * Helper: parse a full URL string into the { search, hash } shape that
 * getCallbackConfig accepts.  This avoids any reliance on window/DOM.
 */
function loc(url: string): { search: string; hash: string } {
  const parsed = new URL(url);
  return { search: parsed.search, hash: parsed.hash };
}

describe("getCallbackConfig", () => {
  test("returns None when no cb/ct params", () => {
    expect(isNone(getCallbackConfig(loc("https://share.plannotator.ai/#abc123")))).toBe(true);
  });

  test("returns Some with params before #", () => {
    const result = getCallbackConfig(
      loc("https://share.plannotator.ai/?cb=https%3A%2F%2Flocalhost%3A9456%2Fplannotator-cb&ct=tok-123#abc"),
    );
    expect(isSome(result)).toBe(true);
    if (isSome(result)) {
      expect(result.value.callbackUrl).toBe("https://localhost:9456/plannotator-cb");
      expect(result.value.token).toBe("tok-123");
    }
  });

  test("returns Some with params after # fragment", () => {
    const result = getCallbackConfig(
      loc("https://share.plannotator.ai/#abc?cb=https%3A%2F%2Flocalhost%3A9456%2Fplannotator-cb&ct=tok-456"),
    );
    expect(isSome(result)).toBe(true);
    if (isSome(result)) {
      expect(result.value.callbackUrl).toBe("https://localhost:9456/plannotator-cb");
      expect(result.value.token).toBe("tok-456");
    }
  });

  test("returns None when only cb is present", () => {
    expect(
      isNone(getCallbackConfig(loc("https://share.plannotator.ai/?cb=https%3A%2F%2Flocalhost%3A9456%2Fplannotator-cb"))),
    ).toBe(true);
  });

  test("returns None when only ct is present", () => {
    expect(isNone(getCallbackConfig(loc("https://share.plannotator.ai/?ct=tok-789")))).toBe(true);
  });

  test("decodes encoded callback URL", () => {
    const encoded = encodeURIComponent("https://bot.internal/plannotator-cb");
    const result = getCallbackConfig(loc(`https://share.plannotator.ai/?cb=${encoded}&ct=tok-abc#hash`));
    expect(isSome(result)).toBe(true);
    if (isSome(result)) {
      expect(result.value.callbackUrl).toBe("https://bot.internal/plannotator-cb");
    }
  });

  test("returns None when params are empty strings", () => {
    expect(isNone(getCallbackConfig(loc("https://share.plannotator.ai/?cb=&ct=")))).toBe(true);
  });

  test("partial params in hash — only hash cb, no ct", () => {
    expect(
      isNone(getCallbackConfig(loc("https://share.plannotator.ai/#abc?cb=https%3A%2F%2Flocalhost%3A9456%2Fcb"))),
    ).toBe(true);
  });

  test("K8s-style URL with encoded colons and slashes decodes correctly", () => {
    const k8sUrl = "http://plannotator-cb.svc.cluster.local:9456/callback";
    const encoded = encodeURIComponent(k8sUrl);
    const result = getCallbackConfig(loc(`https://share.plannotator.ai/?cb=${encoded}&ct=k8s-tok-xyz`));
    expect(isSome(result)).toBe(true);
    if (isSome(result)) {
      expect(result.value.callbackUrl).toBe(k8sUrl);
      expect(result.value.token).toBe("k8s-tok-xyz");
    }
  });
});
