import { describe, expect, test } from "bun:test";
import {
  discoverPlannotatorBinary,
  discoverPlannotatorBinaryCandidates,
  discoverInstalledPlannotatorBinary,
  getOfficialInstallerCommand,
  isCompatiblePluginBinary,
  parsePluginCapabilities,
  shouldAutoInstallPlannotator,
  findPlannotatorSourceRoot,
} from "./plugin-binary";
import { getPluginCapabilities } from "./plugin-protocol";

function existsOnly(paths: string[]) {
  const set = new Set(paths);
  return (candidate: string) => set.has(candidate);
}

describe("discoverPlannotatorBinary", () => {
  test("prefers PLANNOTATOR_BIN when it exists", () => {
    const result = discoverPlannotatorBinary({
      env: { PLANNOTATOR_BIN: "/custom/plannotator", PATH: "/bin" },
      homeDir: "/home/test",
      exists: existsOnly(["/custom/plannotator", "/bin/plannotator"]),
      platform: "darwin",
    });

    expect(result).toMatchObject({
      found: true,
      path: "/custom/plannotator",
      source: "env",
    });
  });

  test("falls back to PATH when explicit override is missing", () => {
    const result = discoverPlannotatorBinary({
      env: { PATH: "/one:/two" },
      homeDir: "/home/test",
      exists: existsOnly(["/two/plannotator"]),
      platform: "linux",
      pathDelimiter: ":",
    });

    expect(result).toMatchObject({
      found: true,
      path: "/two/plannotator",
      source: "path",
    });
  });

  test("uses a source checkout shim before PATH when provided", () => {
    const result = discoverPlannotatorBinary({
      env: { PATH: "/old" },
      homeDir: "/home/test",
      sourceRoot: "/repo/plannotator",
      exists: existsOnly([
        "/repo/plannotator/bin/plannotator.js",
        "/old/plannotator",
      ]),
      platform: "linux",
      pathDelimiter: ":",
    });

    expect(result).toMatchObject({
      found: true,
      path: "/repo/plannotator/bin/plannotator.js",
      source: "source",
    });
  });

  test("uses a Windows source checkout shim before PATH when provided", () => {
    const result = discoverPlannotatorBinary({
      env: { PATH: "C:\\Old" },
      homeDir: "C:\\Users\\test",
      sourceRoot: "C:\\repo\\plannotator",
      exists: existsOnly([
        "C:\\repo\\plannotator/bin/plannotator.cmd",
        "C:\\Old/plannotator.exe",
      ]),
      platform: "win32",
      pathDelimiter: ";",
    });

    expect(result).toMatchObject({
      found: true,
      path: "C:\\repo\\plannotator/bin/plannotator.cmd",
      source: "source",
    });
  });

  test("finds a source root by walking up to the repo shim", () => {
    const existing = new Set([
      "/repo/plannotator/bin/plannotator.js",
      "/repo/plannotator/apps/hook/server/index.ts",
    ]);

    expect(findPlannotatorSourceRoot(
      "/repo/plannotator/apps/pi-extension/generated",
      existsOnly([...existing]),
    )).toBe("/repo/plannotator");
  });

  test("falls back to standard install location", () => {
    const result = discoverPlannotatorBinary({
      env: { PATH: "/one" },
      homeDir: "/home/test",
      exists: existsOnly(["/home/test/.local/bin/plannotator"]),
      platform: "linux",
      pathDelimiter: ":",
    });

    expect(result).toMatchObject({
      found: true,
      path: "/home/test/.local/bin/plannotator",
      source: "standard",
    });
  });

  test("checks Windows executable names", () => {
    const result = discoverPlannotatorBinary({
      env: { PATH: "C:\\Tools" },
      homeDir: "C:\\Users\\test",
      exists: existsOnly(["C:\\Tools/plannotator.exe"]),
      platform: "win32",
      pathDelimiter: ";",
    });

    expect(result).toMatchObject({
      found: true,
      path: "C:\\Tools/plannotator.exe",
      source: "path",
    });
  });

  test("checks the PowerShell installer location on Windows", () => {
    const result = discoverPlannotatorBinary({
      env: { PATH: "", LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
      homeDir: "C:\\Users\\test",
      exists: existsOnly(["C:\\Users\\test\\AppData\\Local/plannotator/plannotator.exe"]),
      platform: "win32",
      pathDelimiter: ";",
    });

    expect(result).toMatchObject({
      found: true,
      path: "C:\\Users\\test\\AppData\\Local/plannotator/plannotator.exe",
      source: "standard",
    });
  });

  test("can rediscover only standard install locations after installation", () => {
    const result = discoverInstalledPlannotatorBinary({
      env: { PLANNOTATOR_BIN: "/old/plannotator", PATH: "/old", LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
      homeDir: "C:\\Users\\test",
      exists: existsOnly([
        "/old/plannotator",
        "C:\\Users\\test\\AppData\\Local/plannotator/plannotator.exe",
      ]),
      platform: "win32",
      pathDelimiter: ";",
    });

    expect(result).toMatchObject({
      found: true,
      path: "C:\\Users\\test\\AppData\\Local/plannotator/plannotator.exe",
      source: "standard",
    });
  });

  test("returns all checked candidates when missing", () => {
    const result = discoverPlannotatorBinary({
      env: { PLANNOTATOR_BIN: "/missing", PATH: "/bin" },
      homeDir: "/home/test",
      exists: existsOnly([]),
      platform: "linux",
      pathDelimiter: ":",
    });

    expect(result.found).toBe(false);
    expect(result.checked).toEqual([
      "/missing",
      "/bin/plannotator",
      "/home/test/.local/bin/plannotator",
    ]);
  });

  test("can return later compatible candidates for capability probing", () => {
    const result = discoverPlannotatorBinaryCandidates({
      env: { PATH: "/old:/current" },
      homeDir: "/home/test",
      exists: existsOnly([
        "/old/plannotator",
        "/current/plannotator",
        "/home/test/.local/bin/plannotator",
      ]),
      platform: "linux",
      pathDelimiter: ":",
    });

    expect(result.candidates).toEqual([
      { path: "/old/plannotator", source: "path" },
      { path: "/current/plannotator", source: "path" },
      { path: "/home/test/.local/bin/plannotator", source: "standard" },
    ]);
  });
});

describe("plugin binary install and capabilities", () => {
  test("auto-install is enabled unless explicitly disabled", () => {
    expect(shouldAutoInstallPlannotator({})).toBe(true);
    expect(shouldAutoInstallPlannotator({ PLANNOTATOR_DISABLE_AUTO_INSTALL: "1" })).toBe(false);
    expect(shouldAutoInstallPlannotator({ PLANNOTATOR_DISABLE_AUTO_INSTALL: "true" })).toBe(false);
    expect(shouldAutoInstallPlannotator({ PLANNOTATOR_DISABLE_AUTO_INSTALL: "yes" })).toBe(false);
  });

  test("selects official installer commands by platform", () => {
    expect(getOfficialInstallerCommand("linux")).toEqual({
      command: "bash",
      args: ["-c", "curl -fsSL https://plannotator.ai/install.sh | bash"],
    });
    expect(getOfficialInstallerCommand("linux", "0.19.17")).toEqual({
      command: "bash",
      args: ["-c", "curl -fsSL https://plannotator.ai/install.sh | bash -s -- --version 'v0.19.17'"],
    });
    expect(getOfficialInstallerCommand("win32").command).toBe("powershell.exe");
    expect(getOfficialInstallerCommand("win32").args.join(" ")).toContain("install.ps1");
    expect(getOfficialInstallerCommand("win32", "v0.19.17").args.join(" ")).toContain("-Version 'v0.19.17'");
  });

  test("parses and validates plugin capabilities", () => {
    const capabilities = getPluginCapabilities();

    expect(parsePluginCapabilities(JSON.stringify(capabilities))).toEqual(capabilities);
    expect(isCompatiblePluginBinary(capabilities)).toBe(true);
    expect(parsePluginCapabilities(JSON.stringify({
      ...capabilities,
      multiSessionDaemon: undefined,
    }))).toMatchObject({
      protocol: capabilities.protocol,
      features: capabilities.features,
    });
    expect(parsePluginCapabilities("{}")).toBeNull();
    expect(parsePluginCapabilities("not-json")).toBeNull();
  });

  test("rejects incompatible protocol versions", () => {
    const capabilities = {
      ...getPluginCapabilities(),
      minClientVersion: 999,
    };

    expect(isCompatiblePluginBinary(capabilities)).toBe(false);
  });

  test("checks required plugin features during compatibility", () => {
    const capabilities = {
      ...getPluginCapabilities(),
      features: ["capabilities", "plan-review"],
    };

    expect(isCompatiblePluginBinary(capabilities, { requiredFeatures: ["plan-review"] })).toBe(true);
    expect(isCompatiblePluginBinary(capabilities, { requiredFeatures: ["archive"] })).toBe(false);
  });
});
