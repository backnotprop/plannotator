/** Pure: every case hands the resolver its own env object; process.env is never touched. */
import { describe, expect, test } from "bun:test";
import {
  BROWSER_NONE_VALUES,
  browserNoneReason,
  isNoOpBrowserSentinel,
  resolveBrowserIntent,
  type BrowserIntent,
} from "./browser-intent";

describe("resolveBrowserIntent", () => {
  // A "none" value on PLANNOTATOR_BROWSER (or --browser) opens nothing, whatever BROWSER says.
  const none: [Record<string, string>, string][] = [
    [{ PLANNOTATOR_BROWSER: "none" }, "none"], // no-browser-guard: sentinel under test
    [{ PLANNOTATOR_BROWSER: "false" }, "false"], // no-browser-guard: sentinel under test
    [{ PLANNOTATOR_BROWSER: "0" }, "0"], // no-browser-guard: sentinel under test
    [{ PLANNOTATOR_BROWSER: "off" }, "off"],
    [{ PLANNOTATOR_BROWSER: "no" }, "no"],
    [{ PLANNOTATOR_BROWSER: "true" }, "true"], // no-browser-guard: sentinel under test
    [{ PLANNOTATOR_BROWSER: "1" }, "1"], // no-browser-guard: sentinel under test
    [{ PLANNOTATOR_BROWSER: ":" }, ":"], // no-browser-guard: sentinel under test
    [{ PLANNOTATOR_BROWSER: "  NONE  " }, "NONE"], // no-browser-guard: sentinel under test
    [{ PLANNOTATOR_BROWSER: "Off" }, "Off"],
    [{ PLANNOTATOR_BROWSER: "none", BROWSER: "/usr/bin/firefox" }, "none"], // no-browser-guard: sentinel under test
  ];
  test.each(none)("%p opens nothing", (env, value) => {
    expect(resolveBrowserIntent(env)).toEqual({ kind: "none", value });
  });

  test("the list of values is exactly the approved one", () => {
    expect([...BROWSER_NONE_VALUES].sort()).toEqual(["0", "1", ":", "false", "no", "none", "off", "true"]);
  });

  // BROWSER is shared with other tools and hosts set it (Claude Code's agent view sets BROWSER=true): its no-op values stay "unset".
  const defaults: Record<string, string>[] = [
    {},
    { PLANNOTATOR_BROWSER: "" },
    { PLANNOTATOR_BROWSER: "   " },
    { BROWSER: "true" },
    { BROWSER: "none" },
    { BROWSER: " FALSE " },
    { BROWSER: ":" },
    { BROWSER: "0" },
    { BROWSER: "1" },
    { BROWSER: "" },
  ];
  test.each(defaults)("%p runs the default chain", (env) => {
    expect(resolveBrowserIntent(env)).toEqual({ kind: "default" });
  });

  const explicit: [Record<string, string>, BrowserIntent][] = [
    [{ PLANNOTATOR_BROWSER: "Google Chrome" }, { kind: "explicit", browser: "Google Chrome", source: "PLANNOTATOR_BROWSER" }],
    [{ PLANNOTATOR_BROWSER: "/usr/bin/true" }, { kind: "explicit", browser: "/usr/bin/true", source: "PLANNOTATOR_BROWSER" }],
    [{ PLANNOTATOR_BROWSER: "open-in-vscode", BROWSER: "firefox" }, { kind: "explicit", browser: "open-in-vscode", source: "PLANNOTATOR_BROWSER" }],
    [{ BROWSER: "firefox" }, { kind: "explicit", browser: "firefox", source: "BROWSER" }],
    // BROWSER no-op values are a fixed set: anything else is a command.
    [{ BROWSER: "off" }, { kind: "explicit", browser: "off", source: "BROWSER" }],
    [{ PLANNOTATOR_BROWSER: "", BROWSER: "firefox" }, { kind: "explicit", browser: "firefox", source: "BROWSER" }],
  ];
  test.each(explicit)("%p launches a handler", (env, intent) => {
    expect(resolveBrowserIntent(env)).toEqual(intent);
  });
});

describe("isNoOpBrowserSentinel (BROWSER)", () => {
  test("keeps #756's six values, any case, spaces ignored", () => {
    for (const value of ["true", "false", "none", ":", "0", "1", "TRUE", "  none  "]) {
      expect(isNoOpBrowserSentinel(value)).toBe(true);
    }
    for (const value of [undefined, "", "off", "no", "/usr/bin/true", "open", "Google Chrome"]) {
      expect(isNoOpBrowserSentinel(value)).toBe(false);
    }
  });
});

describe("browserNoneReason", () => {
  test("names the variable and the value", () => {
    expect(browserNoneReason({ value: "none" })).toBe("Not opening a browser (PLANNOTATOR_BROWSER=none)."); // no-browser-guard: sentinel under test (expected text, nothing is set)
  });
});
