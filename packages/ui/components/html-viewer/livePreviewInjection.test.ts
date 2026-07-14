import { describe, expect, it } from "bun:test";
import { buildLivePreviewInjection } from "./livePreviewInjection";

describe("buildLivePreviewInjection", () => {
  it("emits a style + script block carrying the bridge", () => {
    const out = buildLivePreviewInjection();
    expect(out).toContain("<style");
    expect(out).toContain("<script");
    expect(out).toContain("plannotator-bridge-"); // the PREFIX the bridge uses
  });
});
