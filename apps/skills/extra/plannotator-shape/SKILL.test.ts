/// <reference types="bun-types" />
/// <reference types="node" />

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = import.meta.dir;
const skill = readFileSync(join(dir, "SKILL.md"), "utf-8");
const frame = readFileSync(join(dir, "assets/frame.html"), "utf-8");

// The frame's <style>, comments removed.
const css = () => (frame.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");

// Every declaration of the rules whose selector list includes `selector`
// exactly, however the CSS is formatted: the wide-screen rules only, or with
// the media-query rules too.
function declarations(selector: string, scope: "wide" | "all"): Map<string, string> {
  const out = new Map<string, string>();
  const text = scope === "wide" ? withoutBlocks(css(), /@media\b/) : css();
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].replace(/^[\s\S]*;/, "").split(",").map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    for (const d of m[2].split(";")) {
      const i = d.indexOf(":");
      if (i > 0) out.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
    }
  }
  return out;
}

// The CSS with every block that starts with `start` removed, braces balanced.
function withoutBlocks(text: string, start: RegExp): string {
  let rest = text;
  for (let m = rest.match(start); m?.index !== undefined; m = rest.match(start)) {
    let i = rest.indexOf("{", m.index);
    let depth = 0;
    for (; i < rest.length; i++) {
      if (rest[i] === "{") depth++;
      else if (rest[i] === "}" && --depth === 0) break;
    }
    rest = rest.slice(0, m.index) + rest.slice(i + 1);
  }
  return rest;
}

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
    // A host that passes its theme into the page (the Inbox does for an html
    // fence) sets inline custom properties on <html>, --accent among them, and
    // inline values win over the frame's :root. What --accent means varies by
    // theme: in the "neutral" theme it is a surface colour next to the
    // background, so a frame accent named --accent would vanish there.
    expect(frame).not.toMatch(/--accent\b/);
  });

  test("the view switch sits under the claim, out of the top-right corner", () => {
    // In the Inbox's full screen view and in annotate, the host's own toolbar
    // floats over the page's top-right corner, so a switch there cannot be
    // clicked and How it works is out of reach. The switch must follow the
    // claim in a header that stacks its children, and no rule may push it to
    // the right or lift it out of the flow.
    const html = frame.slice(frame.indexOf("<header>"), frame.indexOf("</header>"));
    expect(html.indexOf('class="switch"')).toBeGreaterThan(html.indexOf('class="claim"'));
    expect(html.indexOf('class="claim"')).toBeGreaterThan(-1);

    // On a wide screen, where the host's toolbar covers the corner.
    const header = declarations("header", "wide");
    expect(header.size).toBeGreaterThan(0);
    const display = header.get("display") ?? "block";
    const stacks = !/flex|grid/.test(display) || (/flex/.test(display) && header.get("flex-direction") === "column");
    expect(stacks).toBe(true);

    const sw = declarations(".switch", "all");
    expect(sw.size).toBeGreaterThan(0);
    expect(sw.get("position") ?? "static").not.toMatch(/absolute|fixed|sticky/);
    expect(sw.get("float") ?? "none").toBe("none");
    expect(sw.get("margin-left") ?? "").not.toBe("auto");
    expect(sw.get("align-self") ?? "auto").not.toMatch(/end|right/);
  });

  test("the frame takes the host's page colours when they are given", () => {
    // Inside a host that passes its theme (an Inbox html fence), the Shape
    // sits on the window's own background and text colours; elsewhere it
    // falls back to its own light and dark.
    expect(frame).toMatch(/--paper:\s*var\(--background,/);
    expect(frame).toMatch(/--ink:\s*var\(--foreground,/);
  });

  test("colours resolve without light-dark() (iOS before 17.5)", () => {
    // A custom property holding light-dark() is valid when parsed and only
    // fails where it is used, so an older engine would drop the accent stroke
    // and the page background. light-dark() stays inside its @supports
    // block; outside it, plain light and dark values define every colour.
    const outside = withoutBlocks(css(), /@supports\s*\(\s*color\s*:\s*light-dark\(/);
    expect(outside.replace(/@supports[^{]*/g, "")).not.toContain("light-dark(");
    const dark = outside.match(/@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{([\s\S]*?)\}\s*\}/)?.[1] ?? "";
    for (const name of ["--paper", "--ink", "--mark"]) {
      expect(outside).toMatch(new RegExp(`${name}\\s*:`));
      expect(dark).toMatch(new RegExp(`${name}\\s*:`));
    }
  });
});
