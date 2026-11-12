import { describe, expect, test } from "bun:test";
import { INBOX_OPEN_IN_DEFAULT_APP, inboxOpenInAllows, inboxOpenInPolicy } from "./inbox-open-in";

describe("inboxOpenInPolicy", () => {
  test("Windows gets the text default apps macOS gets; Linux never does", () => {
    for (const platform of ["mac", "win"] as const) {
      expect(inboxOpenInPolicy({ kind: "text", path: "/p/app.log" }, platform).systemDefault).toBe(true);
      expect(inboxOpenInPolicy({ kind: "text", path: "/p/config.YAML" }, platform).systemDefault).toBe(true);
    }
    expect(inboxOpenInPolicy({ kind: "text", path: "/p/app.log" }, "linux").systemDefault).toBe(false);
  });

  test("an SVG is never handed to its default app (often a browser, which would run its scripts)", () => {
    expect(inboxOpenInPolicy({ kind: "image", path: "/p/logo.svg" }, "mac")).toEqual({ browser: false, editors: false, systemDefault: false });
    expect(inboxOpenInPolicy({ kind: "image", path: "/p/SHOT.PNG" }, "mac").systemDefault).toBe(true);
  });

  test("a kind this build does not know is a plain file: the file manager only", () => {
    const policy = inboxOpenInPolicy({ kind: "hologram", path: "/p/clip.holo" }, "mac");
    expect(policy).toEqual({ browser: false, editors: false, systemDefault: false });
    expect(inboxOpenInAllows(policy, { id: "reveal", kind: "file-manager" })).toBe(true);
    expect(inboxOpenInAllows(policy, { id: INBOX_OPEN_IN_DEFAULT_APP })).toBe(false);
  });

  test("a video opens in the OS default player only when its own extension says video", () => {
    expect(inboxOpenInPolicy({ kind: "video", path: "/p/clip.mov" }, "mac")).toEqual({ browser: false, editors: false, systemDefault: true });
    expect(inboxOpenInPolicy({ kind: "video", path: "/p/cut.webm" }, "linux").systemDefault).toBe(true);
    expect(inboxOpenInPolicy({ kind: "video", path: "/p/clip.bin" }, "mac").systemDefault).toBe(false);
  });

  test("a recording opens in the OS default player only when its own extension says audio", () => {
    expect(inboxOpenInPolicy({ kind: "audio", path: "/p/take.mp3" }, "mac")).toEqual({ browser: false, editors: false, systemDefault: true });
    expect(inboxOpenInPolicy({ kind: "audio", path: "/p/memo.m4a" }, "linux").systemDefault).toBe(true);
    expect(inboxOpenInPolicy({ kind: "audio", path: "/p/take.bin" }, "mac").systemDefault).toBe(false);
  });

  test("a terminal is never allowed, whatever the kind", () => {
    const policy = inboxOpenInPolicy({ kind: "code", path: "/p/run.sh" }, "mac");
    expect(inboxOpenInAllows(policy, { id: "terminal", kind: "terminal" })).toBe(false);
    expect(inboxOpenInAllows(policy, { id: "vscode", kind: "editor" })).toBe(true);
  });
});
