import { describe, expect, test } from "bun:test";
import { getDaemonStartCommand } from "./start-command";

describe("getDaemonStartCommand", () => {
  test("uses Bun plus the source entry when running from TypeScript", () => {
    expect(getDaemonStartCommand(
      ["bun", "apps/hook/server/index.ts"],
      "/usr/local/bin/bun",
      "/repo/plannotator",
    )).toEqual([
      "/usr/local/bin/bun",
      "/repo/plannotator/apps/hook/server/index.ts",
      "daemon",
      "start",
      "--foreground",
    ]);
  });

  test("keeps absolute source entries absolute", () => {
    expect(getDaemonStartCommand(
      ["bun", "/repo/plannotator/apps/hook/server/index.ts"],
      "/usr/local/bin/bun",
      "/other",
    )).toEqual([
      "/usr/local/bin/bun",
      "/repo/plannotator/apps/hook/server/index.ts",
      "daemon",
      "start",
      "--foreground",
    ]);
  });

  test("uses the executable itself for compiled Bun binaries", () => {
    expect(getDaemonStartCommand(["bun", "/$bunfs/root/index"], "/usr/local/bin/plannotator")).toEqual([
      "/usr/local/bin/plannotator",
      "daemon",
      "start",
      "--foreground",
    ]);
  });
});
