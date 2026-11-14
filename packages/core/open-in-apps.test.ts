import { describe, expect, test } from "bun:test";
import {
  OPEN_IN_APPS,
  getOpenInApp,
  openInFileArgv,
  openInMacOpened,
  parseOpenInLine,
} from "./open-in-apps";

const JETBRAINS_IDS = [
  "intellij-idea",
  "webstorm",
  "pycharm",
  "goland",
  "rider",
  "phpstorm",
  "rubymine",
  "clion",
  "rustrover",
] as const;

describe("openInFileArgv", () => {
  const file = "/work/my app/src/a#b.ts";

  test("VS Code and Cursor take --goto path:line; Zed and Sublime take path:line", () => {
    expect(openInFileArgv(getOpenInApp("vscode")!, file, 12)).toEqual(["--goto", `${file}:12`]);
    expect(openInFileArgv(getOpenInApp("cursor")!, file, 12)).toEqual(["--goto", `${file}:12`]);
    expect(openInFileArgv(getOpenInApp("zed")!, file, 12)).toEqual([`${file}:12`]);
    expect(openInFileArgv(getOpenInApp("sublime-text")!, file, 12)).toEqual([`${file}:12`]);
  });

  test("a JetBrains IDE takes --line n path, and a space in the path stays one argument", () => {
    for (const id of JETBRAINS_IDS) {
      const app = getOpenInApp(id)!;
      expect(openInFileArgv(app, file, 42)).toEqual(["--line", "42", file]);
      expect(openInFileArgv(app, file)).toEqual([file]);
    }
  });

  test("no line, or an editor with no cli, is just the path", () => {
    expect(openInFileArgv(getOpenInApp("vscode")!, file)).toEqual([file]);
    expect(openInFileArgv(getOpenInApp("xcode")!, file, 12)).toEqual([file]);
    expect(openInFileArgv(getOpenInApp("reveal")!, file, 12)).toEqual([file]);
  });
});

describe("openInMacOpened", () => {
  const file = "/work/my app/src/a#b.ts";

  test("VS Code and Cursor put the line in the URL; JetBrains has no scheme so the path opens at the top", () => {
    expect(openInMacOpened(getOpenInApp("vscode")!, file, 12)).toBe(
      "vscode://file/work/my%20app/src/a%23b.ts:12",
    );
    expect(openInMacOpened(getOpenInApp("webstorm")!, file, 12)).toBe(file);
    expect(openInMacOpened(getOpenInApp("intellij-idea")!, file, 12)).toBe(file);
  });
});

describe("parseOpenInLine", () => {
  test("only a positive safe integer counts", () => {
    expect(parseOpenInLine(42)).toBe(42);
    expect(parseOpenInLine(1)).toBe(1);
    expect(parseOpenInLine(0)).toBeUndefined();
    expect(parseOpenInLine(-3)).toBeUndefined();
    expect(parseOpenInLine(1.5)).toBeUndefined();
    expect(parseOpenInLine("42")).toBeUndefined();
    expect(parseOpenInLine(undefined)).toBeUndefined();
  });
});

describe("JetBrains catalog entries", () => {
  test("nine IDEs, shared icon, line-flag CLI, no mac URL scheme, after Android Studio", () => {
    const ids = OPEN_IN_APPS.map((app) => app.id);
    expect(ids.slice(ids.indexOf("android-studio"), ids.indexOf("terminal"))).toEqual([
      "android-studio",
      ...JETBRAINS_IDS,
    ]);
    for (const id of JETBRAINS_IDS) {
      const app = getOpenInApp(id)!;
      expect(app.kind).toBe("editor");
      expect(app.icon).toBe("jetbrains");
      expect(app.line).toEqual({ cli: "line-flag" });
      expect(app.mac?.appName).toBeTruthy();
      expect(app.linux?.bin).toBeTruthy();
      expect(app.win?.bin).toBe(app.linux?.bin);
    }
  });
});
