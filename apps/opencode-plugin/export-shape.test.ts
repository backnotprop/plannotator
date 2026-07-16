import { describe, expect, test } from "bun:test";

describe("OpenCode plugin entry export shape", () => {
  test("exports only the default plugin function", async () => {
    const mod = await import("./index");
    const functionExports = Object.entries(mod)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);

    expect(functionExports).toEqual(["default"]);
  });
});
