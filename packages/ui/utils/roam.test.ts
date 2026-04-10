import { beforeEach, describe, expect, test } from "bun:test";
import { storage } from "./storage";
import {
  getRoamSettings,
  isRoamBrowserEnabled,
  isRoamConfigured,
  saveRoamSettings,
} from "./roam";

const keys = [
  "plannotator-roam-enabled",
  "plannotator-roam-graph-name",
  "plannotator-roam-graph-type",
  "plannotator-roam-token",
  "plannotator-roam-port",
  "plannotator-roam-title-format",
  "plannotator-roam-title-separator",
  "plannotator-roam-save-location",
  "plannotator-roam-daily-note-parent",
  "plannotator-roam-autosave",
  "plannotator-roam-reference-browser",
];

let cookieStore = new Map<string, string>();

beforeEach(() => {
  cookieStore = new Map();
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      get cookie() {
        return Array.from(cookieStore.entries())
          .map(([key, value]) => `${key}=${value}`)
          .join("; ");
      },
      set cookie(value: string) {
        const [pair, ...directives] = value.split(";").map((part) => part.trim());
        const [key, rawValue = ""] = pair.split("=");
        if (!key) return;
        if (directives.some((directive) => directive.toLowerCase() === "max-age=0")) {
          cookieStore.delete(key);
          return;
        }
        cookieStore.set(key, rawValue);
      },
    },
  });
  for (const key of keys) {
    storage.removeItem(key);
  }
});

describe("Roam settings helpers", () => {
  test("saveRoamSettings persists and restores Roam settings", () => {
    saveRoamSettings({
      enabled: true,
      graphName: "my-graph",
      graphType: "offline",
      token: "secret-token",
      port: 3333,
      titleFormat: "{title}",
      titleSeparator: "dash",
      saveLocation: "daily-note",
      dailyNoteParent: "[[Custom Plans]]",
      autoSave: true,
      referenceBrowserEnabled: true,
    });

    expect(getRoamSettings()).toEqual({
      enabled: true,
      graphName: "my-graph",
      graphType: "offline",
      token: "secret-token",
      port: 3333,
      titleFormat: "{title}",
      titleSeparator: "dash",
      saveLocation: "daily-note",
      dailyNoteParent: "[[Custom Plans]]",
      autoSave: true,
      referenceBrowserEnabled: true,
    });
  });

  test("getRoamSettings normalizes invalid cookie values", () => {
    storage.setItem("plannotator-roam-graph-type", "cloud");
    storage.setItem("plannotator-roam-title-separator", "comma");
    storage.setItem("plannotator-roam-save-location", "sidebar");
    storage.setItem("plannotator-roam-port", "70000");
    storage.setItem("plannotator-roam-daily-note-parent", "");

    expect(getRoamSettings()).toMatchObject({
      graphType: "hosted",
      titleSeparator: "space",
      saveLocation: "page",
      dailyNoteParent: "[[Plannotator Plans]]",
      port: 3333,
    });
  });

  test("saveRoamSettings clamps invalid ports before persisting", () => {
    saveRoamSettings({
      enabled: true,
      graphName: "my-graph",
      graphType: "offline",
      token: "secret-token",
      port: 70000,
      titleSeparator: "dash",
      saveLocation: "page",
      dailyNoteParent: "[[Plannotator Plans]]",
      autoSave: false,
      referenceBrowserEnabled: false,
    });

    expect(storage.getItem("plannotator-roam-port")).toBe("3333");
    expect(getRoamSettings().port).toBe(3333);
  });

  test("isRoamConfigured and isRoamBrowserEnabled require the right settings", () => {
    expect(isRoamConfigured()).toBe(false);
    expect(isRoamBrowserEnabled()).toBe(false);

    saveRoamSettings({
      enabled: true,
      graphName: "my-graph",
      graphType: "hosted",
      token: "secret-token",
      port: 3333,
      titleSeparator: "space",
      saveLocation: "page",
      dailyNoteParent: "[[Plannotator Plans]]",
      autoSave: false,
      referenceBrowserEnabled: true,
    });

    expect(isRoamConfigured()).toBe(true);
    expect(isRoamBrowserEnabled()).toBe(true);
  });
});
