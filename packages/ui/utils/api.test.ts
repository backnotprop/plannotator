import { afterEach, describe, expect, test } from "bun:test";
import { apiPath, getApiBase, getApiOriginAndBase } from "./api";

const originalWindow = globalThis.window;

function setWindow(value: Partial<Window>) {
  Object.defineProperty(globalThis, "window", {
    value,
    configurable: true,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    value: originalWindow,
    configurable: true,
  });
});

describe("api base helpers", () => {
  test("defaults to root API base", () => {
    setWindow({});
    expect(getApiBase()).toBe("/api");
    expect(apiPath("/plan")).toBe("/api/plan");
    expect(apiPath("/api/plan")).toBe("/api/plan");
  });

  test("uses daemon-injected API base", () => {
    setWindow({ __PLANNOTATOR_API_BASE__: "/s/s1/api" });
    expect(getApiBase()).toBe("/s/s1/api");
    expect(apiPath("/plan")).toBe("/s/s1/api/plan");
    expect(apiPath("plan")).toBe("/s/s1/api/plan");
    expect(apiPath("/api/plan")).toBe("/s/s1/api/plan");
    expect(apiPath("/api/")).toBe("/s/s1/api");
  });

  test("trims trailing slash from injected API base", () => {
    setWindow({ __PLANNOTATOR_API_BASE__: "/s/s1/api/" });
    expect(apiPath("/upload")).toBe("/s/s1/api/upload");
  });

  test("builds absolute origin plus API base for agent instructions", () => {
    setWindow({
      __PLANNOTATOR_API_BASE__: "/s/s1/api",
      location: { origin: "http://localhost:1234" } as Location,
    });
    expect(getApiOriginAndBase()).toBe("http://localhost:1234/s/s1/api");
  });
});
