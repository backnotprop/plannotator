import { beforeEach, describe, expect, test } from "bun:test";
import { storage } from "./storage";
import { getDefaultNotesApp, saveDefaultNotesApp } from "./defaultNotesApp";

const STORAGE_KEY = "plannotator-default-notes-app";

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
  storage.removeItem(STORAGE_KEY);
});

describe("Default notes app preference", () => {
  test("falls back to ask for invalid stored values", () => {
    storage.setItem(STORAGE_KEY, "not-a-real-app");

    expect(getDefaultNotesApp()).toBe("ask");
  });

  test("persists valid notes app choices", () => {
    saveDefaultNotesApp("roam");

    expect(getDefaultNotesApp()).toBe("roam");
  });
});
