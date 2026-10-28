/**
 * The overview diagram's source before it reaches Mermaid: an agent cannot
 * loosen Mermaid's security level or bind a click to anything but a guide link.
 */

import { describe, expect, it } from "bun:test";
import { splitMermaidClicks } from "./adapter";
import { MERMAID_CONFIG } from "../../../../../packages/ui/utils/mermaid";

describe("guide diagram source", () => {
  it("drops %%{init}%% directives, so a diagram cannot loosen Mermaid's security level", () => {
    const { source } = splitMermaidClicks([
      "%%{init: {'securityLevel': 'loose', 'theme': 'dark'}}%%",
      "flowchart LR",
      "  %%{ init: {",
      '    "securityLevel": "loose" } }%%',
      "  a-->b",
    ].join("\n"));
    expect(source).not.toContain("securityLevel");
    expect(source).not.toContain("%%{");
    expect(source).toContain("a-->b");
    // The renderer's own pin, which the directive would have tried to override.
    expect(MERMAID_CONFIG.securityLevel).toBe("strict");
  });

  it("keeps only guide links from click lines and drops every other click binding", () => {
    const { source, clicks } = splitMermaidClicks([
      "flowchart LR",
      "  a-->b",
      '  click a "symbol:computeBackoff"',
      '  click b href "javascript:alert(1)"',
      "  click b call alert(1)",
      '  click a callback "Tooltip"',
      '  CLICK b "https://evil.example"',
    ].join("\n"));
    expect([...clicks]).toEqual([["a", "symbol:computeBackoff"]]);
    expect(source).not.toMatch(/click/i);
    expect(source).not.toContain("javascript:");
  });
});
