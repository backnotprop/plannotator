/// <reference types="bun-types" />
/// <reference types="node" />

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = import.meta.dir;
const skill = readFileSync(join(dir, "SKILL.md"), "utf-8");
const frame = readFileSync(join(dir, "assets/frame.html"), "utf-8");

describe("plannotator-shape", () => {
  test("every file SKILL.md sends the agent to exists", () => {
    // Failure caught: a reference renamed or split while SKILL.md still names
    // the old path, so the agent draws without the drawing rules.
    const named = [...skill.matchAll(/`((?:references|assets)\/[^`]+)`/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThanOrEqual(4);
    for (const path of named) expect(existsSync(join(dir, path)), path).toBe(true);
  });

  test("the frame loads nothing from the network", () => {
    // A Shape is one self-contained file: the Inbox serves attachments with
    // connect-src 'none', and a phone may open it offline.
    expect(frame).not.toMatch(/\b(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i);
    expect(frame).not.toMatch(/@import|url\(\s*["']?(?:https?:)?\/\//i);
  });

  test("the frame never claims the host's --accent token", () => {
    // The Inbox hands an embedded page its theme as inline custom properties on
    // <html>, --accent among them, and inline values win over the frame's
    // :root. What --accent means varies by theme: in the "neutral" theme it is
    // a surface colour next to the background, so a frame accent named
    // --accent would make the "look here first" colour vanish there.
    expect(frame).not.toMatch(/--accent\b/);
    expect(skill).toContain("no `var(--accent)`");
  });

  test("the frame takes the host's page colours when they are given", () => {
    // Inside the Inbox the Shape should sit on the window's own background and
    // text colours; standalone it falls back to its own light and dark.
    expect(frame).toMatch(/--paper:\s*var\(--background,/);
    expect(frame).toMatch(/--ink:\s*var\(--foreground,/);
  });
});
