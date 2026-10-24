import { describe, expect, it } from "bun:test";
import { fromWebviewHost, type MessageWindow } from "./host-messages";

describe("which messages the webview acts on", () => {
  const ORIGIN = "vscode-webview://1a2b3c";
  // VS Code's window → the webview's host frame → this page (whose `parent` VS Code 1.143 sets to itself)
  const top: MessageWindow = { get parent() { return top; }, origin: "vscode-file://vscode-app" };
  const hostFrame: MessageWindow = { parent: top, origin: ORIGIN };
  const self: MessageWindow = { get parent() { return self; }, origin: ORIGIN };
  const answerFrame: MessageWindow = { parent: self, origin: "null" };
  const nested: MessageWindow = { parent: answerFrame, origin: "null" };

  it("the genuine host shape: the page's own origin, whatever the source", () => {
    expect(fromWebviewHost({ source: hostFrame, origin: ORIGIN }, self)).toBe(true);
    expect(fromWebviewHost({ source: { parent: top }, origin: ORIGIN }, self)).toBe(true);
    expect(fromWebviewHost({ source: null, origin: ORIGIN }, self)).toBe(true);
  });

  it("a real foreign origin from outside the page is dropped (a site in the Simple Browser, another extension's webview)", () => {
    const simpleBrowserSite: MessageWindow = { parent: top, origin: "https://evil.example" };
    expect(fromWebviewHost({ source: simpleBrowserSite, origin: "https://evil.example" }, self)).toBe(false);
    expect(fromWebviewHost({ source: { parent: top }, origin: "vscode-webview://other-extension" }, self)).toBe(false);
    expect(fromWebviewHost({ source: top, origin: "vscode-file://vscode-app" }, self)).toBe(false);
  });

  it("never the answer frame or anything nested in it, whatever origin it claims", () => {
    for (const source of [answerFrame, nested]) {
      expect(fromWebviewHost({ source, origin: "null" }, self)).toBe(false);
      expect(fromWebviewHost({ source, origin: ORIGIN }, self)).toBe(false);
    }
  });

  it("a harness page (own origin opaque) takes only messages from itself or its parent", () => {
    const harness: MessageWindow = { get parent() { return harness; }, origin: "null" };
    expect(fromWebviewHost({ source: harness, origin: "null" }, harness)).toBe(true);
    expect(fromWebviewHost({ source: { parent: top }, origin: "null" }, harness)).toBe(false);
    expect(fromWebviewHost({ source: { parent: harness }, origin: "null" }, harness)).toBe(false);
    expect(fromWebviewHost({ source: harness, origin: "https://evil.example" }, harness)).toBe(false);
  });
});
