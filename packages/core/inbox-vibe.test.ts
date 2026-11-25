/**
 * Mistral Vibe's launch facts read from `vibe-acp` itself. The failures this catches: a version line Vibe changes
 * slightly read as no version (To would say "too old"), a model alias that would start with "-" reaching the process
 * env, the session's mode select taken for the model list, and the model env set for a pick that never passed the
 * launch token check (a record edited by hand).
 */
import { describe, expect, test } from "bun:test";
import { parseVibeModels, parseVibeVersion, vibeModelEnv } from "./inbox-vibe";

describe("parseVibeVersion", () => {
  test("reads `vibe-acp -v` and `vibe --version`", () => {
    expect(parseVibeVersion("vibe-acp 3.1.3\n")).toBe("3.1.3");
    expect(parseVibeVersion("vibe 3.2.0")).toBe("3.2.0");
  });
  test("no version: null", () => {
    expect(parseVibeVersion("")).toBeNull();
    expect(parseVibeVersion("command not found")).toBeNull();
  });
});

// `session/new`'s `configOptions` as vibe-acp 3.1.3 answers it (option lists trimmed).
const CONFIG_OPTIONS = [
  { id: "mode", name: "Session Mode", category: "mode", type: "select", currentValue: "smart-approve", options: [{ value: "ask", name: "Ask" }, { value: "auto-approve", name: "Auto Approve" }] },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "claude-opus-5",
    options: [
      { value: "mistral-medium-latest", name: "Mistral Medium 3.5", description: "mistral-medium-latest" },
      { value: "claude-opus-5", name: "claude-opus-5" },
      { value: "-rm", name: "a value argv would read as a flag" },
      { value: "mistral-medium-latest", name: "listed twice" },
    ],
  },
  { id: "thinking", name: "Thinking", category: "thinking", type: "select", currentValue: "high", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
];

describe("parseVibeModels", () => {
  test("the model select's values, checked and deduplicated; no effort column", () => {
    expect(parseVibeModels(CONFIG_OPTIONS)).toEqual({ models: ["mistral-medium-latest", "claude-opus-5"], efforts: [], effort_word: "Thinking" });
  });
  test("grouped options are read too", () => {
    const grouped = [{ id: "model", category: "model", type: "select", currentValue: "a", options: [{ group: "g", name: "G", options: [{ value: "a", name: "A" }] }] }];
    expect(parseVibeModels(grouped)?.models).toEqual(["a"]);
  });
  test("no model select: null", () => {
    expect(parseVibeModels([CONFIG_OPTIONS[0]])).toBeNull();
    expect(parseVibeModels(null)).toBeNull();
  });
});

describe("vibeModelEnv", () => {
  test("a checked pick goes in as VIBE_ACTIVE_MODEL; anything else sets nothing", () => {
    expect(vibeModelEnv("mistral-medium-latest")).toEqual({ VIBE_ACTIVE_MODEL: "mistral-medium-latest" });
    expect(vibeModelEnv(undefined)).toEqual({});
    expect(vibeModelEnv("-rm")).toEqual({});
  });
});
