import { describe, expect, test } from "bun:test";
import { agentSwitchConfigValue, isAgentSwitchName, parseAgentSwitchConfig } from "./agent-switch";

describe("agent switch config values (#1390)", () => {
  test("names, disabled and custom parse as today's choices", () => {
    expect(parseAgentSwitchConfig("disabled")).toEqual({ switchTo: "disabled" });
    expect(parseAgentSwitchConfig("build")).toEqual({ switchTo: "build" });
    expect(parseAgentSwitchConfig("my agent")).toEqual({ switchTo: "my agent" });
    expect(parseAgentSwitchConfig("custom")).toEqual({ switchTo: "custom" });
    expect(parseAgentSwitchConfig({ switchTo: "custom", customName: "reviewer" })).toEqual({ switchTo: "custom", customName: "reviewer" });
  });

  test("anything else is refused", () => {
    for (const bad of [undefined, null, "", " build", "build ", "a\nb", "a\u0000b", "a b", "x".repeat(129), 1, true, [], ["build"], { switchTo: "build" }, { switchTo: "custom" }, { switchTo: "custom", customName: " " }]) {
      expect([JSON.stringify(bad), parseAgentSwitchConfig(bad)]).toEqual([JSON.stringify(bad), undefined]);
    }
    expect(isAgentSwitchName("x".repeat(128))).toBe(true);
  });

  test("a choice writes back to the shape it parses from", () => {
    for (const value of ["disabled", "build", "custom", { switchTo: "custom", customName: "reviewer" }]) {
      expect(agentSwitchConfigValue(parseAgentSwitchConfig(value)!)).toEqual(value as never);
    }
    expect(agentSwitchConfigValue({ switchTo: "build", customName: "reviewer" })).toBe("build");
    expect(agentSwitchConfigValue({ switchTo: "custom" })).toBe("custom");
    expect(agentSwitchConfigValue({ switchTo: "" })).toBeUndefined();
  });
});
