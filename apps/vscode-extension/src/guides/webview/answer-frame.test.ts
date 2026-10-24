import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { ANSWER_BOOTSTRAP, answerThemeCss, buildAnswerDocument, readAnswerMessage } from "./answer-frame";

// A DOM for this file only (the package's run keeps native globals otherwise).
let registrator: { register(): void; unregister(): Promise<void> } | null = null;
beforeAll(async () => {
  if (typeof document !== "undefined") return;
  const path = Bun.resolveSync("@happy-dom/global-registrator", join(import.meta.dir, "..", "..", "..", "..", "..", "packages", "ui"));
  registrator = (await import(path)).GlobalRegistrator;
  registrator!.register();
});
afterAll(async () => {
  await registrator?.unregister();
});

describe("the answer page's frame", () => {
  it("keeps the agent's scripts and puts our theme and link script first in its head", async () => {
    const doc = await buildAnswerDocument(`<p id="x">hi</p><script>document.getElementById('x').textContent = 'ran'</script>`, ":root{--foreground:#fff}", { mermaid: false });
    expect(doc.startsWith("<!DOCTYPE html>")).toBe(true);
    const parsed = new DOMParser().parseFromString(doc, "text/html");
    const scripts = Array.from(parsed.querySelectorAll("script")).map((s) => s.textContent ?? "");
    expect(scripts).toHaveLength(2);
    expect(scripts[0]).toBe(ANSWER_BOOTSTRAP);
    expect(scripts[1]).toContain("textContent = 'ran'");
    expect(parsed.head.querySelector("style")?.textContent).toContain("--foreground:#fff");
    expect(parsed.head.firstElementChild?.getAttribute("charset")).toBe("utf-8");
  });

  it("takes a whole document as the agent wrote it, its head and styles included", async () => {
    const doc = await buildAnswerDocument(`<!doctype html><html><head><style>.box{fill:red}</style></head><body><svg><rect class="box"/></svg></body></html>`, "", { mermaid: false });
    const parsed = new DOMParser().parseFromString(doc, "text/html");
    expect(parsed.head.querySelectorAll("style")).toHaveLength(2);
    expect(parsed.querySelector("rect.box")).not.toBeNull();
  });

  it("accepts only its own messages: guide links, web links and the page height, nothing else", () => {
    expect(readAnswerMessage({ pnAnswer: 1, kind: "link", link: "code:src/x.ts#L2-L4" })).toEqual({ kind: "link", link: "code:src/x.ts#L2-L4" });
    expect(readAnswerMessage({ pnAnswer: 1, kind: "link", link: "chapter:2" })).toEqual({ kind: "link", link: "chapter:2" });
    expect(readAnswerMessage({ pnAnswer: 1, kind: "external", url: "https://example.com/a" })).toEqual({ kind: "external", url: "https://example.com/a" });
    expect(readAnswerMessage({ pnAnswer: 1, kind: "height", height: 512.4 })).toEqual({ kind: "height", height: 512 });
    expect(readAnswerMessage({ pnAnswer: 1, kind: "height", height: 1e9 })).toEqual({ kind: "height", height: 40_000 });
    for (const bad of [
      null,
      "code:x",
      { kind: "link", link: "code:x" },
      { pnAnswer: 1, kind: "link", link: "javascript:alert(1)" },
      { pnAnswer: 1, kind: "link", link: `code:${"x".repeat(3000)}` },
      { pnAnswer: 1, kind: "external", url: "file:///etc/passwd" },
      { pnAnswer: 1, kind: "external", url: "vscode://x" },
      { pnAnswer: 1, kind: "height", height: Number.NaN },
      { pnAnswer: 1, kind: "command", command: "deleteGuide" },
      { type: "command", command: "deleteGuide", args: ["g1"] },
    ]) expect(readAnswerMessage(bad)).toBeNull();
  });

  it("gives the page the editor's colors under short names, with defaults when a variable is missing", () => {
    const css = answerThemeCss((name) => (name === "--vscode-editor-foreground" ? " #abcdef" : ""));
    expect(css).toContain("--foreground: #abcdef;");
    expect(css).toContain("--accent: #4daafc;");
    expect(css).toContain("--chart-1:");
    expect(css).toContain("--mono:");
  });
});
