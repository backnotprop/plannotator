import { describe, expect, test } from "bun:test";
import { AGENT_CONFIG, getAgentAIProviderTypes, getAgentBadge, getAgentName } from "./agents";

describe("getAgentName", () => {
  test("resolves oh-my-pi to its display name", () => {
    expect(getAgentName("oh-my-pi")).toBe("Oh My Pi");
  });

  test("falls back to Coding Agent for null/undefined/unknown origins", () => {
    expect(getAgentName(null)).toBe("Coding Agent");
    expect(getAgentName(undefined)).toBe("Coding Agent");
    expect(getAgentName("not-a-real-origin" as never)).toBe("Coding Agent");
  });
});

describe("getAgentBadge", () => {
  test("resolves oh-my-pi badge classes", () => {
    expect(getAgentBadge("oh-my-pi")).toBe("bg-fuchsia-500/15 text-fuchsia-400");
  });
});

describe("getAgentAIProviderTypes", () => {
  test("oh-my-pi has no dedicated Ask AI provider", () => {
    expect(getAgentAIProviderTypes("oh-my-pi")).toEqual([]);
  });
});

describe("pi vs oh-my-pi are distinct origins", () => {
  test("both keys exist in AGENT_CONFIG with different names", () => {
    // Guards against conflating the Pi coding agent with the oh-my-pi harness.
    expect("pi" in AGENT_CONFIG).toBe(true);
    expect("oh-my-pi" in AGENT_CONFIG).toBe(true);
    expect(AGENT_CONFIG.pi.name).not.toBe(AGENT_CONFIG["oh-my-pi"].name);
    expect(AGENT_CONFIG.pi.name).toBe("Pi");
    expect(AGENT_CONFIG["oh-my-pi"].name).toBe("Oh My Pi");
  });
});
