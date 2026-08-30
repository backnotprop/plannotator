/// <reference types="bun-types" />
/// <reference types="node" />

/**
 * The skill documents an HTTP contract and two behaviors that live in code:
 * the annotation types the server accepts, and the fact that DELETION's `text`
 * is discarded by the export. Both are the kind of claim that goes stale
 * silently — the skill keeps rendering fine while telling an agent something
 * untrue. These pin the claims to their sources.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const skill = readFileSync(join(import.meta.dir, "SKILL.md"), "utf-8");
const repoRoot = join(import.meta.dir, "../../../..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf-8");

describe("plannotator-markup contract freshness", () => {
  test("documents the endpoint the servers actually mount", () => {
    const handler = read("packages/server/external-annotations.ts");
    const base = handler.match(/const BASE = "([^"]+)"/)?.[1];
    expect(base).toBe("/api/external-annotations");
    expect(skill).toContain(base!);
  });

  test("documents exactly the annotation types the plan transformer accepts", () => {
    const core = read("packages/core/external-annotation.ts");
    const listed = core.match(/VALID_PLAN_TYPES[^=]*=\s*\[([^\]]+)\]/)?.[1];
    expect(listed).toBeDefined();
    const types = [...listed!.matchAll(/["']([A-Z_]+)["']/g)].map((m) => m[1]!);
    expect(types.length).toBeGreaterThan(0);

    // Every accepted type is named in the skill's field table, and the skill
    // invents none — an agent told about a fourth type would get a 400.
    for (const type of types) expect(skill).toContain(type);
    for (const type of skill.match(/\b[A-Z]+_?[A-Z]*COMMENT\b|\bDELETION\b/g) ?? []) {
      expect(types).toContain(type);
    }
  });

  test("still warns that DELETION discards its text", () => {
    const parser = read("packages/ui/utils/parser.ts");
    const deletionBranch = parser.slice(
      parser.indexOf("case 'DELETION':"),
      parser.indexOf("case 'COMMENT':"),
    );
    expect(deletionBranch.length).toBeGreaterThan(0);
    // The export writes a fixed sentence and never `ann.text`. The moment it
    // does, the skill's "DELETION carries no message" guidance is wrong.
    expect(deletionBranch).not.toContain("ann.text");
    expect(skill).toContain("`DELETION` carries no message");
  });

  test("still tells the agent that `plannotator sessions` writes to stderr", () => {
    // Without the redirect an agent's pipe reads empty and the whole flow
    // stalls at step 2, so this is the skill's most load-bearing detail.
    expect(skill).toContain("2>&1");
    expect(skill).toMatch(/writes to \*\*stderr\*\*/);
  });

  test("section references match the resolver's rules", () => {
    const resolver = read("packages/ui/utils/sectionRefs.ts");
    expect(resolver).toContain("export function parseSectionRefs");
    expect(skill).toContain("### Referring to another section");
    // The one rule an agent has to follow for a reference to resolve.
    expect(skill).toContain("copied verbatim");
  });
});
