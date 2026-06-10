import { describe, expect, test } from "bun:test";
import { PERMISSION_MODE_OPTIONS } from "./permissionMode";

describe("permission mode options", () => {
  test("includes all supported permission modes shown in Settings", () => {
    expect(PERMISSION_MODE_OPTIONS.map((option) => option.value)).toEqual([
      "acceptEdits",
      "bypassPermissions",
      "default",
      "deferNative",
    ]);
  });
});
