import { describe, expect, test } from "bun:test";
import { parseT3Args } from "./cli";

const scope = ["--url", "http://127.0.0.1:3773/mcp", "--thread", "thread-a"];
describe("T3 CLI scope and review arguments", () => {
  test("keeps bundle targets with spaces intact and forwards review options", () => {
    expect(parseT3Args(["annotate", "a file.md", "b.md", ...scope, "--gate", "--markdown"]).review)
      .toEqual({ action: "annotate", target: ["a file.md", "b.md"], gate: true, options: { markdown: true } });
    expect(parseT3Args(["review", ...scope, "--base", "origin/main"]).review)
      .toEqual({ action: "review", options: { base: "origin/main" } });
    expect(parseT3Args(["close", "ABCDEF", ...scope]).review).toEqual({ action: "close", session: "pn-abcdef" });
  });
  test("requires explicit scope and rejects flags or targets that an action cannot use", () => {
    for (const args of [
      ["annotate", "a.md", "--url", scope[1]!],
      ["annotate", ...scope],
      ["review", ...scope, "--gate"],
      ["last", ...scope, "notes.md"],
      ["list", ...scope, "--base", "main"],
      ["review", ...scope, "--thread", "thread-b"],
      ["close", ...scope],
      ["mcp", ...scope],
      ["list", ...scope, "--thread", ""],
    ]) expect(() => parseT3Args(args)).toThrow();
  });
  test("login authorizes the environment without binding a thread", () => {
    expect(parseT3Args(["login", "--url", scope[1]!]).thread).toBeUndefined();
    expect(() => parseT3Args(["login", ...scope])).toThrow("takes no --thread");
  });
});
