import { describe, expect, test } from "bun:test";
import { getOpenInApp } from "@plannotator/core/open-in-apps";
import { locateOpenInApp, type OpenInLocateDeps } from "./open-in-locate";

// Every dependency is stubbed: nothing here reads this computer's PATH or disk.
function deps(over: Partial<OpenInLocateDeps> & Pick<OpenInLocateDeps, "platform">): OpenInLocateDeps {
  return {
    which: () => null,
    exists: () => false,
    listDirs: () => [],
    env: {},
    home: "/Users/me",
    ...over,
  };
}

const app = (id: string) => getOpenInApp(id)!;

describe("locateOpenInApp on Windows (exeOnly JetBrains IDEs)", () => {
  test("the IDE's .exe on PATH is launched by its absolute path", () => {
    const found = locateOpenInApp(
      app("webstorm"),
      deps({
        platform: "win",
        which: (bin) => (bin === "webstorm64.exe" ? "C:\\Program Files\\JetBrains\\WebStorm 2026.3\\bin\\webstorm64.exe" : null),
      }),
    );
    expect(found).toBe("C:\\Program Files\\JetBrains\\WebStorm 2026.3\\bin\\webstorm64.exe");
  });

  test("a Toolbox user with only the idea.cmd script sees no entry, never a broken one", () => {
    const asked: string[] = [];
    const found = locateOpenInApp(
      app("intellij-idea"),
      deps({
        platform: "win",
        which: (bin) => {
          asked.push(bin);
          // What PATH lookup finds for a bare `idea` on a Toolbox machine.
          return bin === "idea" ? "C:\\Users\\me\\AppData\\Local\\JetBrains\\Toolbox\\scripts\\idea.cmd" : null;
        },
      }),
    );
    expect(found).toBeNull();
    // Only the .exe name is ever looked up; the script name is never asked for.
    expect(asked).toEqual(["idea64.exe"]);
  });

  test("a lookup that answers a script for the .exe name is refused", () => {
    const found = locateOpenInApp(
      app("goland"),
      deps({ platform: "win", which: () => "C:\\tools\\goland64.exe.cmd" }),
    );
    expect(found).toBeNull();
  });

  test("an IDE the Toolbox App installed under %LOCALAPPDATA%\\Programs is found by its .exe", () => {
    const exe = "C:\\Users\\me\\AppData\\Local\\Programs\\PyCharm\\bin\\pycharm64.exe";
    const found = locateOpenInApp(
      app("pycharm"),
      deps({
        platform: "win",
        env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
        listDirs: (dir) => (dir === "C:\\Users\\me\\AppData\\Local\\Programs" ? ["Git", "PyCharm"] : []),
        exists: (p) => p === exe,
      }),
    );
    expect(found).toBe(exe);
  });

  test("the standalone installer's folder under %ProgramFiles%\\JetBrains is found too", () => {
    const exe = "C:\\Program Files\\JetBrains\\JetBrains Rider 2026.3\\bin\\rider64.exe";
    const found = locateOpenInApp(
      app("rider"),
      deps({
        platform: "win",
        env: { ProgramFiles: "C:\\Program Files" },
        listDirs: (dir) => (dir === "C:\\Program Files\\JetBrains" ? ["JetBrains Rider 2026.3"] : []),
        exists: (p) => p === exe,
      }),
    );
    expect(found).toBe(exe);
  });

  test("RustRover is found under either launcher name", () => {
    const found = locateOpenInApp(
      app("rustrover"),
      deps({ platform: "win", which: (bin) => (bin === "rustrover64.exe" ? "C:\\RR\\bin\\rustrover64.exe" : null) }),
    );
    expect(found).toBe("C:\\RR\\bin\\rustrover64.exe");
  });

  test("an IDE that is not installed is not offered", () => {
    for (const id of ["intellij-idea", "webstorm", "pycharm", "goland", "rider", "phpstorm", "rubymine", "clion", "rustrover"]) {
      expect(locateOpenInApp(app(id), deps({ platform: "win", env: { LOCALAPPDATA: "C:\\L", ProgramFiles: "C:\\P" } }))).toBeNull();
    }
  });

  test("VS Code keeps its PATH name as before", () => {
    expect(locateOpenInApp(app("vscode"), deps({ platform: "win", which: (bin) => (bin === "code" ? "C:\\VS\\bin\\code.cmd" : null) }))).toBe("code");
  });
});

describe("locateOpenInApp on macOS", () => {
  test("the bundle in /Applications or the Toolbox App's ~/Applications", () => {
    expect(
      locateOpenInApp(app("goland"), deps({ platform: "mac", exists: (p) => p === "/Applications/GoLand.app" })),
    ).toBe("GoLand");
    expect(
      locateOpenInApp(app("clion"), deps({ platform: "mac", exists: (p) => p === "/Users/me/Applications/CLion.app" })),
    ).toBe("CLion");
  });

  test("IntelliJ IDEA and PyCharm under their edition bundle names", () => {
    expect(
      locateOpenInApp(app("intellij-idea"), deps({ platform: "mac", exists: (p) => p === "/Applications/IntelliJ IDEA CE.app" })),
    ).toBe("IntelliJ IDEA CE");
    expect(
      locateOpenInApp(
        app("intellij-idea"),
        deps({ platform: "mac", exists: (p) => p === "/Users/me/Applications/IntelliJ IDEA Ultimate.app" }),
      ),
    ).toBe("IntelliJ IDEA Ultimate");
    expect(
      locateOpenInApp(app("pycharm"), deps({ platform: "mac", exists: (p) => p === "/Applications/PyCharm CE.app" })),
    ).toBe("PyCharm CE");
  });

  test("a launcher script on PATH without the bundle is not enough", () => {
    expect(locateOpenInApp(app("webstorm"), deps({ platform: "mac", which: () => "/usr/local/bin/webstorm" }))).toBeNull();
  });
});

describe("locateOpenInApp on Linux", () => {
  test("the launcher script on PATH, else a snap command", () => {
    expect(locateOpenInApp(app("phpstorm"), deps({ platform: "linux", which: (b) => (b === "phpstorm" ? "/snap/bin/phpstorm" : null) }))).toBe("phpstorm");
    expect(
      locateOpenInApp(app("intellij-idea"), deps({ platform: "linux", which: (b) => (b === "intellij-idea-community" ? "/snap/bin/intellij-idea-community" : null) })),
    ).toBe("intellij-idea-community");
    expect(
      locateOpenInApp(app("pycharm"), deps({ platform: "linux", which: (b) => (b === "pycharm-professional" ? "/snap/bin/pycharm-professional" : null) })),
    ).toBe("pycharm-professional");
  });

  test("nothing on PATH: not offered", () => {
    expect(locateOpenInApp(app("rubymine"), deps({ platform: "linux" }))).toBeNull();
  });
});
