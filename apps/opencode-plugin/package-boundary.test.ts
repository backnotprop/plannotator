import { describe, expect, test } from "bun:test";
import packageJson from "./package.json";

describe("OpenCode package entrypoints", () => {
  test("keeps V1 on main and exposes V2 from the package root", () => {
    expect(packageJson.main).toBe("dist/index.js");
    // OpenCode 1 checks ./server before main, so that subpath must remain absent.
    expect(packageJson.exports).toEqual({
      ".": "./dist/server.js",
    });
  });
});
