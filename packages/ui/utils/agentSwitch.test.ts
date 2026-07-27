import { afterEach, describe, expect, test } from "bun:test";
import { resetStorageBackend, setStorageBackend, type StorageBackend } from "./storage";
import { getAgentSwitchSettings, getEffectiveAgentName, saveAgentSwitchSettings } from "./agentSwitch";

function memoryStorage(initial: Record<string, string> = {}): StorageBackend {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

afterEach(() => {
  resetStorageBackend();
});

describe("agent switch settings", () => {
  test("review feedback defaults to no switch/current agent when unset", () => {
    setStorageBackend(memoryStorage());

    const settings = getAgentSwitchSettings("review");

    expect(settings.switchTo).toBe("disabled");
    expect(getEffectiveAgentName(settings)).toBeUndefined();
  });

  test("plan approval defaults to the build hand-off when unset", () => {
    setStorageBackend(memoryStorage());

    const settings = getAgentSwitchSettings("plan");

    expect(settings.switchTo).toBe("build");
    expect(getEffectiveAgentName(settings)).toBe("build");
    expect(getAgentSwitchSettings().switchTo).toBe("build");
  });

  test("an explicit choice overrides the surface default everywhere", () => {
    setStorageBackend(memoryStorage());

    saveAgentSwitchSettings({ switchTo: "disabled" });

    expect(getAgentSwitchSettings("plan").switchTo).toBe("disabled");
    expect(getAgentSwitchSettings("review").switchTo).toBe("disabled");
  });

  test("keeps an explicitly saved target agent", () => {
    setStorageBackend(memoryStorage());

    saveAgentSwitchSettings({ switchTo: "build" });

    const settings = getAgentSwitchSettings("review");
    expect(settings.switchTo).toBe("build");
    expect(getEffectiveAgentName(settings)).toBe("build");
  });

  test("does not emit custom as an agent when no custom name is set", () => {
    expect(getEffectiveAgentName({ switchTo: "custom" })).toBeUndefined();
  });
});
