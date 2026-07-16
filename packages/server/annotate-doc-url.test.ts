import { describe, expect, test } from "bun:test";
import { applyAnnotateDocSessionParams } from "./annotate-doc-url";

describe("applyAnnotateDocSessionParams", () => {
  test("adds source base and markdown conversion for local HTML annotate sessions", () => {
    const result = applyAnnotateDocSessionParams(
      "http://localhost/api/doc?path=linked.html",
      "/tmp/docs/page.html",
      true,
    );

    const url = new URL(result.url);
    expect(result.changed).toBe(true);
    expect(url.searchParams.get("base")).toBe("/tmp/docs");
    expect(url.searchParams.get("convert")).toBe("1");
  });

  test("does not override explicit doc request params", () => {
    const result = applyAnnotateDocSessionParams(
      "http://localhost/api/doc?path=linked.html&base=/custom&convert=0",
      "/tmp/docs/page.html",
      true,
    );

    const url = new URL(result.url);
    expect(result.changed).toBe(false);
    expect(url.searchParams.get("base")).toBe("/custom");
    expect(url.searchParams.get("convert")).toBe("0");
  });

  test("skips local base injection for URL annotations", () => {
    const result = applyAnnotateDocSessionParams(
      "http://localhost/api/doc?path=linked.html",
      "https://example.test/page.html",
      true,
    );

    const url = new URL(result.url);
    expect(result.changed).toBe(true);
    expect(url.searchParams.has("base")).toBe(false);
    expect(url.searchParams.get("convert")).toBe("1");
  });
});
