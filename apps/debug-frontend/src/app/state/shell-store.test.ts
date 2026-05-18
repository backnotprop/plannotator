import { describe, expect, test } from "vitest";
import { createShellStore } from "./shell-store";

describe("shell store", () => {
  test("tracks shell panel and diagnostics state", () => {
    const store = createShellStore();

    store.getState().setActivePanel("diagnostics");
    store.getState().setCompactDensity(true);
    store.getState().toggleDiagnostics();

    expect(store.getState().activePanel).toBe("diagnostics");
    expect(store.getState().compactDensity).toBe(true);
    expect(store.getState().diagnosticsOpen).toBe(true);
  });
});
