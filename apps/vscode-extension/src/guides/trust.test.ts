import { describe, expect, it } from "bun:test";
import { approveAlwaysTarget, isKnownPullRequestUrl } from "./trust";

describe("Always approve during guides", () => {
  const generation = { id: "draft-1", live: true, pending: [3] };
  const askPending = (run: string | undefined, id: number | undefined) => run === "ans-1-abcd" && id === 7;

  it("acts only on a run and a request really waiting on the user", () => {
    expect(approveAlwaysTarget("draft-1", 3, { generation, askPending })).toBe("generation");
    expect(approveAlwaysTarget("ans-1-abcd", 7, { generation, askPending })).toBe("ask");
  });

  it("a mismatched run id, permission id, a missing id or a finished run changes nothing", () => {
    expect(approveAlwaysTarget("draft-2", 3, { generation, askPending })).toBeNull();
    expect(approveAlwaysTarget("draft-1", 4, { generation, askPending })).toBeNull();
    expect(approveAlwaysTarget("draft-1", undefined, { generation, askPending })).toBeNull();
    expect(approveAlwaysTarget(undefined, 3, { generation, askPending })).toBeNull();
    expect(approveAlwaysTarget("ans-1-abcd", 8, { generation, askPending })).toBeNull();
    expect(approveAlwaysTarget("draft-1", 3, { generation: { ...generation, live: false }, askPending })).toBeNull();
    expect(approveAlwaysTarget("draft-1", 3, { generation: null, askPending })).toBeNull();
  });
});

describe("pull request links that open without asking", () => {
  const known = ["https://github.com/northwind/checkout-service/pull/482", null, undefined];
  it("the extension's own PR URLs, however they are spelled", () => {
    expect(isKnownPullRequestUrl("https://github.com/northwind/checkout-service/pull/482", known)).toBe(true);
    expect(isKnownPullRequestUrl("https://github.com/Northwind/checkout-service/pull/482/", known)).toBe(true);
    expect(isKnownPullRequestUrl("https://github.com/northwind/checkout-service/pull/482?tab=files", known)).toBe(true);
  });
  it("anything else asks first", () => {
    expect(isKnownPullRequestUrl("https://evil.example/pull/482", known)).toBe(false);
    expect(isKnownPullRequestUrl("https://github.com/northwind/checkout-service/pull/4821", known)).toBe(false);
    expect(isKnownPullRequestUrl("http://github.com/northwind/checkout-service/pull/482", known)).toBe(false);
    expect(isKnownPullRequestUrl("javascript:alert(1)", known)).toBe(false);
  });
});
