import { afterEach, describe, expect, test } from "bun:test";
import { resetStorageBackend, setStorageBackend, type StorageBackend } from "./storage";
import { getAgentSwitchSettings, getEffectiveAgentName, saveAgentSwitchSettings } from "./agentSwitch";
import { ConfigStoreForTest } from "../config/configStore";

const SWITCH_COOKIE = "plannotator-agent-switch";
const CUSTOM_COOKIE = "plannotator-agent-custom";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const backend: StorageBackend = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  return { values, backend };
}

function freshStore(cookies: Record<string, string> = {}) {
  const jar = memoryStorage(cookies);
  setStorageBackend(jar.backend);
  const store = new ConfigStoreForTest();
  const posted: Record<string, unknown>[] = [];
  store.setServerSync((payload) => { posted.push(payload); });
  return { store, jar, posted };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 350));

afterEach(() => {
  resetStorageBackend();
});

describe("agent switch settings", () => {
  test("review feedback defaults to no switch/current agent when unset", () => {
    const { store, jar } = freshStore();
    const settings = getAgentSwitchSettings("review", store);
    expect(settings.switchTo).toBe("disabled");
    expect(getEffectiveAgentName(settings)).toBeUndefined();
    expect(jar.values.has(SWITCH_COOKIE)).toBe(false);
  });

  test("plan approval defaults to the build hand-off when unset", () => {
    const { store } = freshStore();
    const settings = getAgentSwitchSettings("plan", store);
    expect(settings.switchTo).toBe("build");
    expect(getEffectiveAgentName(settings)).toBe("build");
  });

  test("an explicit choice overrides the surface default everywhere", () => {
    const { store } = freshStore();
    saveAgentSwitchSettings({ switchTo: "disabled" }, store);
    expect(getAgentSwitchSettings("plan", store).switchTo).toBe("disabled");
    expect(getAgentSwitchSettings("review", store).switchTo).toBe("disabled");
  });

  test("a choice is saved to the cookie and to config.json (#1390)", async () => {
    const { store, jar, posted } = freshStore();
    saveAgentSwitchSettings({ switchTo: "disabled" }, store);
    expect(jar.values.get(SWITCH_COOKIE)).toBe("disabled");
    await flush();
    expect(posted).toEqual([{ agentSwitch: "disabled" }]);
  });

  test("the Custom field is saved in its own shape", async () => {
    const { store, jar, posted } = freshStore();
    saveAgentSwitchSettings({ switchTo: "custom", customName: "reviewer" }, store);
    expect(jar.values.get(CUSTOM_COOKIE)).toBe("reviewer");
    await flush();
    expect(posted).toEqual([{ agentSwitch: { switchTo: "custom", customName: "reviewer" } }]);
  });

  test("config.json's choice is read with no cookie at all (the Glimpse case)", () => {
    const { store, jar } = freshStore();
    store.init({ agentSwitch: "disabled" });
    expect(getAgentSwitchSettings("plan", store)).toEqual({ switchTo: "disabled" });
    expect(jar.values.get(SWITCH_COOKIE)).toBe("disabled");

    const custom = freshStore();
    custom.store.init({ agentSwitch: { switchTo: "custom", customName: "reviewer" } });
    const settings = getAgentSwitchSettings("plan", custom.store);
    expect(settings).toEqual({ switchTo: "custom", customName: "reviewer" });
    expect(getEffectiveAgentName(settings)).toBe("reviewer");
  });

  test("config.json wins over the cookie", () => {
    const { store } = freshStore({ [SWITCH_COOKIE]: "build" });
    store.init({ agentSwitch: "architect" });
    expect(getAgentSwitchSettings("plan", store).switchTo).toBe("architect");
  });

  test("the cookie applies when config.json has no choice, or one that does not parse", () => {
    for (const serverConfig of [{}, { agentSwitch: { switchTo: "build" } }, { agentSwitch: "" }, { agentSwitch: 7 }]) {
      const { store } = freshStore({ [SWITCH_COOKIE]: "disabled" });
      store.init(serverConfig);
      expect([JSON.stringify(serverConfig), getAgentSwitchSettings("plan", store).switchTo]).toEqual([JSON.stringify(serverConfig), "disabled"]);
    }
  });

  test("a cookie that is not a valid name is ignored", () => {
    const { store } = freshStore({ [SWITCH_COOKIE]: " build\n" });
    expect(getAgentSwitchSettings("plan", store).switchTo).toBe("build");
    expect(getAgentSwitchSettings("review", store).switchTo).toBe("disabled");
  });

  test("keeps an explicitly saved target agent", () => {
    const { store } = freshStore();
    saveAgentSwitchSettings({ switchTo: "build" }, store);
    const settings = getAgentSwitchSettings("review", store);
    expect(settings.switchTo).toBe("build");
    expect(getEffectiveAgentName(settings)).toBe("build");
  });

  test("Custom with its name cleared removes the old name, so that agent is not revived", () => {
    const { store, jar } = freshStore({ [SWITCH_COOKIE]: "custom", [CUSTOM_COOKIE]: "old-agent" });
    expect(getEffectiveAgentName(getAgentSwitchSettings("plan", store))).toBe("old-agent");
    saveAgentSwitchSettings({ switchTo: "custom", customName: "" }, store);
    expect(jar.values.has(CUSTOM_COOKIE)).toBe(false);
    const reload = new ConfigStoreForTest();
    expect(getEffectiveAgentName(getAgentSwitchSettings("plan", reload))).toBeUndefined();
  });

  test("config.json's bare \"custom\" is not paired with a leftover cookie name", () => {
    const { store } = freshStore({ [CUSTOM_COOKIE]: "old-agent" });
    store.init({ agentSwitch: "custom" });
    const settings = getAgentSwitchSettings("plan", store);
    expect(settings).toEqual({ switchTo: "custom" });
    expect(getEffectiveAgentName(settings)).toBeUndefined();
  });

  test("does not emit custom as an agent when no custom name is set", () => {
    expect(getEffectiveAgentName({ switchTo: "custom" })).toBeUndefined();
  });
});
