import { describe, expect, test } from "bun:test";
import { unsafeWindowsShellInvocationError } from "./plugin-client";

describe("unsafeWindowsShellInvocationError", () => {
  test("accepts safe Windows command wrappers", () => {
    expect(
      unsafeWindowsShellInvocationError(
        "C:\\Tools\\plannotator.cmd",
        ["plugin", "plan", "--origin", "opencode"],
        "win32",
      ),
    ).toBeUndefined();
  });

  test("rejects metacharacters in Windows command wrapper paths", () => {
    expect(
      unsafeWindowsShellInvocationError(
        "C:\\Tools&Bad\\plannotator.cmd",
        ["plugin", "plan"],
        "win32",
      ),
    ).toContain("C:\\Tools&Bad\\plannotator.cmd");
  });

  test("rejects metacharacters in Windows command wrapper arguments", () => {
    expect(
      unsafeWindowsShellInvocationError(
        "C:\\Tools\\plannotator.cmd",
        ["plugin", "plan", "--origin", "opencode&calc"],
        "win32",
      ),
    ).toContain("opencode&calc");
  });

  test("rejects delayed-expansion markers in Windows command wrapper arguments", () => {
    expect(
      unsafeWindowsShellInvocationError(
        "C:\\Tools\\plannotator.cmd",
        ["plugin", "plan", "--origin", "opencode!calc"],
        "win32",
      ),
    ).toContain("opencode!calc");
  });

  test("does not apply shell-wrapper checks on non-Windows platforms", () => {
    expect(
      unsafeWindowsShellInvocationError(
        "/tmp/a&b/plannotator.cmd",
        ["opencode&calc"],
        "linux",
      ),
    ).toBeUndefined();
  });
});
