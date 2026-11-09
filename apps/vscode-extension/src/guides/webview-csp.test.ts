import { describe, expect, it } from "bun:test";
import { webviewCsp } from "./webview-csp";

const SOURCE = "https://file+.vscode-resource.vscode-cdn.net";
const directives = (csp: string) => Object.fromEntries(csp.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));

describe("the Guides webviews' scripts", () => {
  it("outside the answer tab: only the nonced script and what it loads itself, no host listed", () => {
    for (const mode of ["home", "generating"] as const) {
      const d = directives(webviewCsp(SOURCE, "abc", mode));
      expect(d["script-src"]).toEqual(["'nonce-abc'", "'strict-dynamic'"]);
      expect(d["script-src"]).not.toContain(SOURCE);
      expect(d["script-src"]).not.toContain("'unsafe-inline'");
      expect(d["default-src"]).toEqual(["'none'"]);
      expect(d["connect-src"]).toBeUndefined();
    }
  });

  it("the answer tab allows inline scripts for the agent's sandboxed page, and nothing connects", () => {
    const d = directives(webviewCsp(SOURCE, "abc", "answer"));
    expect(d["script-src"]).toEqual([SOURCE, "'unsafe-inline'"]);
    expect(d["connect-src"]).toBeUndefined();
  });
});
