import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import * as vscode from "vscode";
import { createMockExtensionContext } from "../mocks/vscode";
import { activate } from "./extension";

describe("activate", () => {
  let context: ReturnType<typeof createMockExtensionContext>;
  const spies: Array<{ mockRestore: () => void }> = [];

  beforeEach(() => {
    context = createMockExtensionContext("/test/extension/path");
  });

  afterEach(() => {
    for (const sub of context.subscriptions) sub.dispose();
    for (const spy of spies) spy.mockRestore();
    spies.length = 0;
  });

  it("starts IPC server and injects port env var when config enabled", async () => {
    await activate(context as unknown as vscode.ExtensionContext);

    const port = context.environmentVariableCollection.get("PLANNOTATOR_VSCODE_PORT");
    expect(port).toBeDefined();
    expect(Number(port)).toBeGreaterThan(0);
  });

  it("injects PLANNOTATOR_BROWSER env var when config is enabled", async () => {
    const spy = spyOn(vscode.workspace, "getConfiguration");
    spy.mockReturnValue({
      get(key: string, defaultValue?: unknown) {
        if (key === "injectBrowser") return true;
        return defaultValue;
      },
    } as ReturnType<typeof vscode.workspace.getConfiguration>);
    spies.push(spy);

    await activate(context as unknown as vscode.ExtensionContext);

    expect(context.environmentVariableCollection.get("PLANNOTATOR_BROWSER")).toBe(
      "/test/extension/path/bin/open-in-vscode",
    );
  });

  it("prepends bin/ to PATH when injectBrowser is enabled", async () => {
    const spy = spyOn(vscode.workspace, "getConfiguration");
    spy.mockReturnValue({
      get(key: string, defaultValue?: unknown) {
        if (key === "injectBrowser") return true;
        return defaultValue;
      },
    } as ReturnType<typeof vscode.workspace.getConfiguration>);
    spies.push(spy);

    await activate(context as unknown as vscode.ExtensionContext);

    const pathValue = context.environmentVariableCollection.get("PATH");
    expect(pathValue).toContain("/test/extension/path/bin");
  });

  it("does not prepend PATH when injectBrowser is false", async () => {
    const spy = spyOn(vscode.workspace, "getConfiguration");
    spy.mockReturnValue({
      get(key: string, defaultValue?: unknown) {
        if (key === "injectBrowser") return false;
        return defaultValue;
      },
    } as ReturnType<typeof vscode.workspace.getConfiguration>);
    spies.push(spy);

    await activate(context as unknown as vscode.ExtensionContext);

    expect(context.environmentVariableCollection.get("PATH")).toBeUndefined();
  });

  it("does not inject env vars when injectBrowser is false", async () => {
    const spy = spyOn(vscode.workspace, "getConfiguration");
    spy.mockReturnValue({
      get(key: string, defaultValue?: unknown) {
        if (key === "injectBrowser") return false;
        return defaultValue;
      },
    } as ReturnType<typeof vscode.workspace.getConfiguration>);
    spies.push(spy);

    await activate(context as unknown as vscode.ExtensionContext);

    expect(context.environmentVariableCollection.get("PLANNOTATOR_BROWSER")).toBeUndefined();
    expect(context.environmentVariableCollection.get("PLANNOTATOR_VSCODE_PORT")).toBeUndefined();
  });

  it("registers the openUrl command", async () => {
    const spy = spyOn(vscode.commands, "registerCommand");
    spies.push(spy);

    await activate(context as unknown as vscode.ExtensionContext);

    expect(spy).toHaveBeenCalledWith(
      "plannotator-webview.openUrl",
      expect.any(Function),
    );
  });

  it("pushes disposables to context.subscriptions", async () => {
    await activate(context as unknown as vscode.ExtensionContext);

    expect(context.subscriptions.length).toBeGreaterThanOrEqual(2);
  });
});
