import { describe, expect, test } from "bun:test";
import {
  getCallFlowLanguageForPath,
  getCallFlowPatchFiles,
  getCallFlowPatchLanguageUsage,
  parseCallFlowInstallRequest,
  resolveCallFlowInstallTargets,
} from "./call-flow-languages";

describe("Call flow language preflight", () => {
  test("maps both sides of quoted renames without losing the old language", () => {
    const patch = [
      'diff --git "a/old name.py" "b/new name.ts"',
      'similarity index 90%',
      'rename from old name.py',
      'rename to new name.ts',
      '--- "a/old name.py"',
      '+++ "b/new name.ts"',
      '@@ -1 +1 @@',
      '-pass',
      '+export const value = 1',
    ].join("\n");

    expect(getCallFlowPatchFiles(patch)).toEqual(["old name.py", "new name.ts"]);
    expect(getCallFlowPatchLanguageUsage(patch).map(({ language, files }) => [language.id, files])).toEqual([
      ["javascript-typescript", ["new name.ts"]],
      ["python", ["old name.py"]],
    ]);
  });

  test("matches extensions case-insensitively and ignores unsupported files", () => {
    expect(getCallFlowLanguageForPath("src/Thing.CS")?.id).toBe("csharp");
    expect(getCallFlowLanguageForPath("README.md")).toBeNull();
    expect(getCallFlowLanguageForPath("src/no-extension")).toBeNull();
  });

  test("strictly parses install targets and rejects extra fields", () => {
    expect(parseCallFlowInstallRequest({})).toEqual({});
    expect(parseCallFlowInstallRequest({ languageIds: ["python", "python", "go"] })).toEqual({ languageIds: ["python", "go"] });
    expect(parseCallFlowInstallRequest({ languageIds: ["unknown"] })).toBeNull();
    expect(parseCallFlowInstallRequest({ languageIds: "python" })).toBeNull();
    expect(parseCallFlowInstallRequest({ languageIds: [] })).toBeNull();
    expect(parseCallFlowInstallRequest({ languageIds: [], surprise: true })).toBeNull();
  });

  test("keeps explicit manual targets separate from the current review plan", () => {
    const plan = ["javascript-typescript", "python"] as const;
    expect(resolveCallFlowInstallTargets(undefined, plan, false)).toEqual(["javascript-typescript", "python"]);
    expect(resolveCallFlowInstallTargets(["ruby"], plan, false)).toEqual(["javascript-typescript", "ruby"]);
    expect(resolveCallFlowInstallTargets(["ruby"], ["python"], true)).toEqual(["ruby"]);
  });
});
