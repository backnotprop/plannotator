import { describe, expect, test } from "bun:test";
import { resolveSessionTailscale, sessionTailscaleOptOut } from "./config";

// PLANNOTATOR_TAILSCALE / config.json "tailscale": the per-session `--tailscale`
// as a default, so a host or agent need not pass the flag on every call.
describe("resolveSessionTailscale", () => {
  test("the flag turns it on whatever the env var or config say", () => {
    expect(resolveSessionTailscale({ tailscale: false }, { PLANNOTATOR_TAILSCALE: "0" }, true)).toEqual({ on: true, source: "flag" });
  });

  test("the env var turns it on without the flag, and off against the config key", () => {
    expect(resolveSessionTailscale({}, { PLANNOTATOR_TAILSCALE: "1" })).toEqual({ on: true, source: "env" });
    expect(resolveSessionTailscale({}, { PLANNOTATOR_TAILSCALE: " ON " })).toEqual({ on: true, source: "env" });
    expect(resolveSessionTailscale({ tailscale: true }, { PLANNOTATOR_TAILSCALE: "0" })).toEqual({ on: false, source: "env" });
    expect(resolveSessionTailscale({ tailscale: true }, { PLANNOTATOR_TAILSCALE: "disabled" })).toEqual({ on: false, source: "env" });
  });

  test("an empty or unrecognized env value leaves it to the config key", () => {
    expect(resolveSessionTailscale({ tailscale: true }, { PLANNOTATOR_TAILSCALE: "" })).toEqual({ on: true, source: "config" });
    expect(resolveSessionTailscale({ tailscale: true }, { PLANNOTATOR_TAILSCALE: "yes please" })).toEqual({ on: true, source: "config" });
    expect(resolveSessionTailscale({ tailscale: "true" as never }, {})).toEqual({ on: true, source: "config" });
  });

  test("off by default, and the Inbox's own key and env var do not leak into sessions", () => {
    expect(resolveSessionTailscale({}, {})).toEqual({ on: false, source: "default" });
    expect(resolveSessionTailscale({ inboxTailscale: true }, { PLANNOTATOR_INBOX_TAILSCALE: "1" })).toEqual({ on: false, source: "default" });
  });
});

describe("sessionTailscaleOptOut", () => {
  test("only the flag's opt-out says to drop the flag", () => {
    expect(sessionTailscaleOptOut("flag")).toContain("without --tailscale");
    expect(sessionTailscaleOptOut("env")).toContain("PLANNOTATOR_TAILSCALE");
    expect(sessionTailscaleOptOut("config")).toContain("PLANNOTATOR_TAILSCALE=0");
    expect(sessionTailscaleOptOut("env")).not.toContain("without --tailscale");
    expect(sessionTailscaleOptOut("config")).not.toContain("without --tailscale");
  });
});
