/// <reference types="bun-types" />
/// <reference types="node" />

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const themeOverride = readFileSync(
  join(import.meta.dir, "references/theme-override.md"),
  "utf-8",
);
const mermaidStart = themeOverride.indexOf("## Mermaid theming");
const mermaidEnd = themeOverride.indexOf("\n## ", mermaidStart + 1);
const mermaidSection = themeOverride.slice(mermaidStart, mermaidEnd);
const exampleStart = mermaidSection.indexOf("```javascript");
const exampleEnd = mermaidSection.indexOf("```", exampleStart + 3);
const mermaidExample = mermaidSection.slice(exampleStart, exampleEnd);
const mermaidExampleCode = mermaidExample.slice(
  mermaidExample.indexOf("\n") + 1,
);
const skill = readFileSync(join(import.meta.dir, "SKILL.md"), "utf-8");

interface CapturedMermaidConfig {
  theme?: string;
  themeVariables?: Record<string, unknown>;
}

function captureMermaidConfig(colorScheme: "light" | "dark") {
  let captured: CapturedMermaidConfig | undefined;
  const runExample = new Function(
    "mermaid",
    "getComputedStyle",
    "window",
    "document",
    mermaidExampleCode,
  );

  runExample(
    {
      initialize: (config: CapturedMermaidConfig) => {
        captured = config;
      },
    },
    () => ({ colorScheme }),
    { matchMedia: () => ({ matches: colorScheme === "dark" }) },
    { documentElement: {} },
  );

  if (!captured?.themeVariables) {
    throw new Error(`Mermaid example did not initialize the ${colorScheme} palette`);
  }

  return { name: colorScheme, config: captured };
}

describe("plannotator-visual-explainer Mermaid theming", () => {
  test("keeps the Mermaid theming section", () => {
    expect(mermaidStart).toBeGreaterThan(-1);
    expect(mermaidEnd).toBeGreaterThan(mermaidStart);
    expect(exampleStart).toBeGreaterThan(-1);
    expect(exampleEnd).toBeGreaterThan(exampleStart);
  });

  test("uses Mermaid-compatible literal colors", () => {
    const literalColors = mermaidExample.match(/#[0-9a-f]{6}\b/gi) ?? [];
    expect(mermaidExample).toContain("themeVariables");
    expect(literalColors.length).toBeGreaterThanOrEqual(10);
  });

  test("keeps CSS color processing outside Mermaid themeVariables", () => {
    expect(mermaidSection).not.toMatch(/\boklch\(\s*[^)]/i);
    expect(mermaidSection).not.toMatch(/\bvar\(\s*[^)]/i);
    expect(mermaidSection).not.toMatch(/\bcolor-mix\(\s*[^)]/i);
  });

  test("preserves OKLCH for ordinary page CSS", () => {
    expect(themeOverride).toMatch(/--background:\s+oklch\(/);
    expect(themeOverride).toMatch(
      /@media \(prefers-color-scheme: dark\)[\s\S]*--background:\s+oklch\(/,
    );
  });

  test("renders representative Mermaid 11 diagrams in both palettes", async () => {
    const palettes = [captureMermaidConfig("light"), captureMermaidConfig("dark")];
    const uiPackageDir = join(import.meta.dir, "../../../../packages/ui");
    const renderProbe = String.raw`
      import { GlobalRegistrator } from "@happy-dom/global-registrator";

      GlobalRegistrator.register();
      const [{ default: mermaid }, { default: mermaidPackage }] = await Promise.all([
        import("mermaid"),
        import("mermaid/package.json", { with: { type: "json" } }),
      ]);

      if (!String(mermaidPackage.version).startsWith("11.")) {
        throw new Error("Expected Mermaid 11, received " + mermaidPackage.version);
      }

      const palettes = JSON.parse(process.env.PLANNOTATOR_MERMAID_PALETTES ?? "[]");
      const diagrams = [
        {
          name: "architecture",
          source: "flowchart TD\n  A[Provider] --> B[Database]",
          labels: ["Provider", "Database"],
        },
        {
          name: "review-flow",
          source: "flowchart LR\n  U([Reviewer]) --> D{Approve?}\n  D -->|Yes| M[(Merge)]\n  D -->|No| R[Revise]",
          labels: ["Reviewer", "Approve?", "Merge", "Revise"],
        },
      ];
      const errorSignature = /aria-roledescription\s*=\s*["']error["']|Syntax error in text/i;
      const knownErrorOutputs = [
        '<svg aria-roledescription="error"></svg>',
        '<svg><text>Syntax error in text</text></svg>',
      ];

      if (knownErrorOutputs.some((output) => !errorSignature.test(output))) {
        throw new Error("Mermaid error-output guard does not recognize its required signatures");
      }

      for (const palette of palettes) {
        for (const diagram of diagrams) {
          mermaid.initialize({
            ...palette.config,
            startOnLoad: false,
            // Happy DOM cannot run DOMPurify's strict-mode serialization, but Mermaid's
            // parser, theme derivation, layout, and SVG renderer all execute in loose mode.
            securityLevel: "loose",
          });
          const { diagramType, svg } = await mermaid.render(
            "probe-" + palette.name + "-" + diagram.name,
            diagram.source,
          );

          if (!svg || !/<svg\b/i.test(svg)) {
            throw new Error(palette.name + "/" + diagram.name + " produced an empty SVG");
          }
          if (diagramType === "error" || errorSignature.test(svg)) {
            throw new Error(palette.name + "/" + diagram.name + " produced Mermaid error output");
          }
          if (!/aria-roledescription=["']flowchart-v2["']/.test(svg)) {
            throw new Error(palette.name + "/" + diagram.name + " was not rendered as a flowchart");
          }
          for (const colorKey of ["primaryColor", "primaryTextColor"]) {
            const color = String(palette.config.themeVariables?.[colorKey] ?? "").toLowerCase();
            if (!color || !svg.toLowerCase().includes(color)) {
              throw new Error(
                palette.name + "/" + diagram.name + " did not apply " + colorKey,
              );
            }
          }
          for (const label of diagram.labels) {
            if (!svg.includes(label)) {
              throw new Error(palette.name + "/" + diagram.name + " omitted label " + label);
            }
          }
        }
      }

      console.log(
        "Rendered " + (palettes.length * diagrams.length) +
          " Mermaid " + mermaidPackage.version + " SVGs without error signatures",
      );
    `;
    const child = Bun.spawn(
      [process.execPath, "--cwd", uiPackageDir, "-e", renderProbe],
      {
        env: {
          ...process.env,
          PLANNOTATOR_MERMAID_PALETTES: JSON.stringify(palettes),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    if (exitCode !== 0) {
      throw new Error(`Mermaid render probe failed:\n${stderr || stdout}`);
    }
    expect(stdout).toMatch(
      /Rendered 4 Mermaid 11\.[0-9.]+\.[0-9]+ SVGs without error signatures/,
    );
  }, 20_000);

  test("keeps Mermaid rendering as a pre-delivery gate", () => {
    expect(skill).toContain("render every diagram with Mermaid 11");
    expect(skill).toContain('aria-roledescription="error"');
    expect(skill).toContain("Syntax error in text");
    expect(skill).toContain("the explainer is not deliverable");
  });
});
