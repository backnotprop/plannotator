import { describe, expect, it } from "bun:test";
import { parseReaderMessage } from "./reader-protocol";

const at = { path: "src/webhooks/deliver.ts", side: "new", line: 31, character: 42, token: "computeBackoff" };

describe("messages from the Guide tab", () => {
  it("accepts the messages the reader sends, as they are", () => {
    expect(parseReaderMessage({ type: "ready" })).toEqual({ type: "ready" });
    expect(parseReaderMessage({ type: "hover", reqId: 3, at })).toEqual({ type: "hover", reqId: 3, at: at as never });
    expect(parseReaderMessage({ type: "references", reqId: 4, at: { ...at, side: "old" } })).toMatchObject({ type: "references", at: { side: "old" } });
    expect(parseReaderMessage({ type: "navigate", at, action: "definition" })).toMatchObject({ type: "navigate", action: "definition" });
    expect(parseReaderMessage({ type: "toggleReviewed", chapter: 1 })).toEqual({ type: "toggleReviewed", chapter: 1 });
    expect(parseReaderMessage({ type: "toggleFileReviewed", path: "a/b.ts" })).toEqual({ type: "toggleFileReviewed", path: "a/b.ts" });
    expect(parseReaderMessage({ type: "openFile", path: "a/b.ts", line: 3 })).toEqual({ type: "openFile", path: "a/b.ts", line: 3 });
    expect(parseReaderMessage({ type: "openDiff", path: "a/b.ts" })).toEqual({ type: "openDiff", path: "a/b.ts" });
    expect(parseReaderMessage({ type: "openLocation", path: "a/b.ts", line: 3, character: 0 })).toEqual({ type: "openLocation", path: "a/b.ts", line: 3, character: 0, side: "new" });
    expect(parseReaderMessage({ type: "openLocation", path: "a/b.ts", line: 3, character: 0, side: "old" })).toMatchObject({ side: "old" });
    expect(parseReaderMessage({ type: "chapter", chapter: 0 })).toEqual({ type: "chapter", chapter: 0 });
    expect(parseReaderMessage({ type: "ask", question: "Why?", chapter: 2 })).toEqual({ type: "ask", question: "Why?", chapter: 2 });
    expect(parseReaderMessage({ type: "ask", question: "Why?", path: "a.ts", start: 25, end: 31 })).toEqual({ type: "ask", question: "Why?", path: "a.ts", side: "new", start: 25, end: 31 });
    expect(parseReaderMessage({ type: "ask", question: "Why?", path: "a.ts", side: "old", start: 4, end: 6 })).toEqual({ type: "ask", question: "Why?", path: "a.ts", side: "old", start: 4, end: 6 });
    expect(parseReaderMessage({ type: "openAnswer", id: "ans-1761200000000-ab12" })).toEqual({ type: "openAnswer", id: "ans-1761200000000-ab12" });
    expect(parseReaderMessage({ type: "command", command: "export" })).toEqual({ type: "command", command: "export" });
    expect(parseReaderMessage({ type: "link", href: "symbol:computeBackoff", action: "definition" })).toEqual({ type: "link", href: "symbol:computeBackoff", action: "definition" });
    expect(parseReaderMessage({ type: "mermaidResult", reqId: 1, ok: false, message: "Parse error", line: 3 })).toEqual({ type: "mermaidResult", reqId: 1, ok: false, message: "Parse error", line: 3 });
    expect(parseReaderMessage({ type: "mermaidResult", reqId: 2, ok: false, unavailable: true })).toEqual({ type: "mermaidResult", reqId: 2, ok: false, unavailable: true });
    expect(parseReaderMessage({ type: "mermaidResult", reqId: 2, ok: false, unavailable: "yes" })).toEqual({ type: "mermaidResult", reqId: 2, ok: false });
  });

  it("drops anything that is not one of them", () => {
    for (const bad of [null, "ready", 3, [], {}, { type: "eval", code: "x" }, { type: "command", command: "rm" }, { type: "command", command: "export; rm" }]) {
      expect(parseReaderMessage(bad)).toBeNull();
    }
  });

  it("refuses paths outside the repository: absolute, drive letters, `..`, NUL", () => {
    for (const path of ["/etc/passwd", "C:/x.ts", "c:\\\\x.ts", "../x.ts", "src/../../x.ts", "src\\\\..\\\\x.ts", "a\u0000b", "", "x".repeat(5000)]) {
      expect(parseReaderMessage({ type: "openFile", path })).toBeNull();
      expect(parseReaderMessage({ type: "hover", reqId: 1, at: { ...at, path } })).toBeNull();
    }
  });

  it("refuses positions that are not whole numbers in range, and long tokens", () => {
    for (const bad of [{ line: 0 }, { line: 1.5 }, { line: "3" }, { character: -1 }, { side: "both" }, { token: "x".repeat(600) }, { token: 3 }]) {
      expect(parseReaderMessage({ type: "hover", reqId: 1, at: { ...at, ...bad } })).toBeNull();
    }
    expect(parseReaderMessage({ type: "hover", reqId: -1, at })).toBeNull();
    expect(parseReaderMessage({ type: "navigate", at, action: "rename" })).toBeNull();
  });

  it("an ask is about a chapter or about lines (end not before start), with a bounded question", () => {
    expect(parseReaderMessage({ type: "ask", question: "Why?" })).toBeNull();
    expect(parseReaderMessage({ type: "ask", question: "Why?", path: "a.ts", start: 9, end: 3 })).toBeNull();
    expect(parseReaderMessage({ type: "ask", question: "Why?", path: "a.ts", start: 3 })).toBeNull();
    expect(parseReaderMessage({ type: "ask", question: "x".repeat(4001), chapter: 0 })).toBeNull();
    expect(parseReaderMessage({ type: "ask", question: "Why?", chapter: -1 })).toBeNull();
    expect(parseReaderMessage({ type: "ask", question: "Why?", path: "a.ts", side: "both", start: 1, end: 2 })).toBeNull();
  });

  it("a blank question asks nothing", () => {
    for (const question of ["", "   ", "\n\t "]) expect(parseReaderMessage({ type: "ask", question, chapter: 0 })).toBeNull();
    expect(parseReaderMessage({ type: "openLocation", path: "a.ts", line: 1, character: 0, side: "both" })).toBeNull();
  });

  it("a link is a guide link only, and an answer id has the answer's shape", () => {
    expect(parseReaderMessage({ type: "link", href: "https://example.com", action: "open" })).toBeNull();
    expect(parseReaderMessage({ type: "link", href: "command:workbench.action.terminal.new", action: "open" })).toBeNull();
    expect(parseReaderMessage({ type: "openAnswer", id: "../x" })).toBeNull();
  });

  it("keeps only the fields it knows", () => {
    const parsed = parseReaderMessage({ type: "openDiff", path: "a.ts", extra: "<script>" });
    expect(parsed).toEqual({ type: "openDiff", path: "a.ts" });
  });
});
