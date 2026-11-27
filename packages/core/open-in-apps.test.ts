import { describe, expect, test } from "bun:test";
import {
  OPEN_IN_APPS,
  getOpenInApp,
  isWindowsExePath,
  openInCandidateNames,
  openInFileArgv,
  openInMacArgv,
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

  test("VS Code and Cursor put the line in the URL; JetBrains has no scheme (its line rides openInMacArgv)", () => {
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

describe("openInMacArgv", () => {
  const file = "/work/my app/src/a#b.ts";

  test("a JetBrains IDE at a line goes through its own launcher: open -na <app> --args --line n path", () => {
    for (const id of JETBRAINS_IDS) {
      const app = getOpenInApp(id)!;
      expect(openInMacArgv(app, app.mac!.appName, file, 42)).toEqual([
        "-na",
        app.mac!.appName,
        "--args",
        "--line",
        "42",
        file,
      ]);
      // No line: these IDEs use the plain `open -a`.
      expect(openInMacArgv(app, app.mac!.appName, file)).toEqual(["-a", app.mac!.appName, file]);
    }
  });

  test("an installed bundle's other name is the one handed to open", () => {
    const idea = getOpenInApp("intellij-idea")!;
    expect(openInMacArgv(idea, "IntelliJ IDEA CE", file, 7)).toEqual([
      "-na",
      "IntelliJ IDEA CE",
      "--args",
      "--line",
      "7",
      file,
    ]);
  });

  test("Android Studio opens a file through its own launcher even without a selected line", () => {
    const app = getOpenInApp("android-studio")!;
    expect(openInMacArgv(app, app.mac!.appName, file)).toEqual([
      "-na", "Android Studio", "--args", "--line", "1", file,
    ]);
    expect(openInMacArgv(app, app.mac!.appName, file, 42)).toEqual([
      "-na", "Android Studio", "--args", "--line", "42", file,
    ]);
  });

  test("other apps keep open -a with the URL scheme or the path", () => {
    expect(openInMacArgv(getOpenInApp("vscode")!, "Visual Studio Code", file, 12)).toEqual([
      "-a",
      "Visual Studio Code",
      "vscode://file/work/my%20app/src/a%23b.ts:12",
    ]);
    expect(openInMacArgv(getOpenInApp("zed")!, "Zed", file, 12)).toEqual(["-a", "Zed", file]);
  });
});

describe("JetBrains catalog entries", () => {
  test("nine IDEs after Android Studio, each with its own icon, opening at a line on every platform", () => {
    const ids = OPEN_IN_APPS.map((app) => app.id);
    expect(ids.slice(ids.indexOf("android-studio"), ids.indexOf("terminal"))).toEqual([
      "android-studio",
      ...JETBRAINS_IDS,
    ]);
    const icons = JETBRAINS_IDS.map((id) => getOpenInApp(id)!.icon);
    expect(new Set(icons).size).toBe(JETBRAINS_IDS.length);
    for (const id of JETBRAINS_IDS) {
      const app = getOpenInApp(id)!;
      expect(app.kind).toBe("editor");
      expect(app.line).toEqual({ macArgs: "line-flag", cli: "line-flag" });
      expect(app.mac?.appName).toBeTruthy();
      expect(app.linux?.bin).toBeTruthy();
    }
  });

  test("on Windows only the IDEs' own .exe launchers are named, never a .cmd or .bat script", () => {
    for (const id of JETBRAINS_IDS) {
      const app = getOpenInApp(id)!;
      expect(app.win?.exeOnly).toBe(true);
      const names = openInCandidateNames(app, "win");
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(name).toMatch(/^[a-z]+(64)?\.exe$/);
    }
    expect(openInCandidateNames(getOpenInApp("intellij-idea")!, "win")).toEqual(["idea64.exe"]);
    expect(openInCandidateNames(getOpenInApp("rider")!, "win")).toEqual(["rider64.exe"]);
    // VS Code keeps its `code` (a .cmd on Windows): unchanged here.
    expect(getOpenInApp("vscode")!.win).toEqual({ bin: "code" });
  });

  test("IntelliJ IDEA and PyCharm are also found under their edition bundles and snap commands", () => {
    expect(openInCandidateNames(getOpenInApp("intellij-idea")!, "mac")).toEqual([
      "IntelliJ IDEA",
      "IntelliJ IDEA Ultimate",
      "IntelliJ IDEA CE",
    ]);
    expect(openInCandidateNames(getOpenInApp("intellij-idea")!, "linux")).toEqual([
      "idea",
      "intellij-idea",
      "intellij-idea-ultimate",
      "intellij-idea-community",
    ]);
    expect(openInCandidateNames(getOpenInApp("pycharm")!, "mac")).toEqual(["PyCharm", "PyCharm CE"]);
    expect(openInCandidateNames(getOpenInApp("pycharm")!, "linux")).toEqual([
      "pycharm",
      "pycharm-professional",
      "pycharm-community",
    ]);
  });
});

describe("isWindowsExePath", () => {
  test("only a .exe passes", () => {
    expect(isWindowsExePath("C:\\Program Files\\JetBrains\\WebStorm\\bin\\webstorm64.exe")).toBe(true);
    expect(isWindowsExePath("C:\\x\\IDEA64.EXE")).toBe(true);
    expect(isWindowsExePath("C:\\Users\\me\\AppData\\Local\\JetBrains\\Toolbox\\scripts\\idea.cmd")).toBe(false);
    expect(isWindowsExePath("C:\\JetBrains\\bin\\idea.bat")).toBe(false);
  });
});
