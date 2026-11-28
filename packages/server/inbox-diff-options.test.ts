/**
 * The Inbox's `diff_options` (inbox-diff-options.ts): Settings → Reviews saves the code font, its size, Power Up and
 * its motion through it, in config.json's `diffOptions` names, so code review reads them; a value code review would
 * not take is refused, and one config.json holds that the Inbox cannot show reads as never chosen. No server.
 */
import { expect, test } from "bun:test";
import { inboxDiffOptionsOf, parseInboxDiffOptionsChange } from "./inbox-diff-options";

test("the code font, its size, Power Up and its motion save under code review's names", () => {
  const change = parseInboxDiffOptionsChange({ diff_options: { font_family: "JetBrains Mono", font_size: "15px", power_up: false, power_up_motion: "stream" } });
  expect(change).toEqual({ ok: true, diffOptions: { fontFamily: "JetBrains Mono", fontSize: "15px", powerUp: false, powerUpMotion: "stream" } });
  // Empty is the theme's font and size, as code review's Reset saves it.
  expect(parseInboxDiffOptionsChange({ diff_options: { font_family: "", font_size: "" } })).toEqual({ ok: true, diffOptions: { fontFamily: "", fontSize: "" } });
});

test("a value code review's page would never save is refused, by field", () => {
  for (const [key, value] of [
    ["font_size", "30px"],
    ["font_size", "13"],
    ["font_family", "x".repeat(201)],
    ["font_family", "Mono\n"],
    ["power_up", "yes"],
    ["power_up_motion", "fast"],
  ] as const) {
    const change = parseInboxDiffOptionsChange({ diff_options: { [key]: value } });
    expect(change.ok ? null : change.field).toBe(`diff_options.${key}`);
  }
});

test("config.json's values read back on the wire; one the Inbox cannot show reads as never chosen", () => {
  expect(inboxDiffOptionsOf({ fontFamily: "Hack", fontSize: "12px", powerUp: true, powerUpMotion: "still" })).toMatchObject({ font_family: "Hack", font_size: "12px", power_up: true, power_up_motion: "still" });
  expect(inboxDiffOptionsOf({ fontSize: "1em" })).toMatchObject({ font_family: null, font_size: null, power_up: null, power_up_motion: null });
});
