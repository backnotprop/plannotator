/**
 * Freshness guard for the plannotator knowledge skill
 * (apps/skills/core/plannotator/SKILL.md).
 *
 * The failure this catches: the skill is a prose copy of the CLI surface, and
 * prose copies drift. What each assertion actually covers differs, so do not
 * read this file as a blanket "the skill is complete" proof:
 *
 *   - Subcommands: BIDIRECTIONAL. Every subcommand the skill documents must
 *     exist in the CLI, and every user-facing CLI subcommand must appear in
 *     the skill. A renamed, removed, or newly added subcommand fails here.
 *   - Flags: ONE-DIRECTIONAL. Every flag the skill mentions must be accepted
 *     somewhere in the CLI, so a renamed or deleted flag fails. The reverse
 *     is NOT asserted: a new CLI flag that the skill never mentions passes.
 *     Making that bidirectional needs per-subcommand flag scoping (a global
 *     "every flag must be documented" set would demand the skill list every
 *     flag of every subcommand) and is deliberately left as follow-up.
 *   - Origins: BIDIRECTIONAL on values. The PLANNOTATOR_ORIGIN row must name
 *     every AGENT_CONFIG key and no key the config does not have, so adding
 *     an origin (like oh-my-pi, #1373) cannot silently leave the row stale.
 *
 * Sources of truth: the usage text in cli.ts (plus GUIDE_CLI_USAGE via the
 * guide entry), the argument-parsing sites in the CLI source files, and
 * AGENT_CONFIG in packages/core/agents.ts.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_CONFIG } from "@plannotator/shared/agents";
import {
  formatTopLevelHelp,
  SUBCOMMAND_HELP,
  SUBCOMMAND_HELP_ALIASES,
} from "./cli";

const SKILL_MD_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "skills",
  "core",
  "plannotator",
  "SKILL.md",
);

// CLI sources that parse flags. index.ts strips flags via
// args.indexOf/includes; the shared parsers use case/=== comparisons.
const PARSER_SOURCES = [
  join(import.meta.dir, "index.ts"),
  join(import.meta.dir, "cli.ts"),
  join(import.meta.dir, "..", "..", "..", "packages", "shared", "review-args.ts"),
  join(import.meta.dir, "..", "..", "..", "packages", "server", "guide", "guide-cli.ts"),
];

const FLAG_TOKEN = /--[a-z][a-z0-9-]*/g;

function extractFlagsFromUsageText(text: string): Set<string> {
  return new Set(text.match(FLAG_TOKEN) ?? []);
}

function extractFlagsFromParserSource(source: string): Set<string> {
  const flags = new Set<string>();
  // args.indexOf("--x") / args.includes("--x")
  for (const m of source.matchAll(
    /args\.(?:indexOf|includes)\(\s*"(--[a-z][a-z0-9-]*)"/g,
  )) {
    flags.add(m[1]);
  }
  // case "--x": / === "--x" / !== "--x" comparisons in hand-rolled parsers
  for (const m of source.matchAll(
    /(?:case\s+|[=!]==\s*)"(--[a-z][a-z0-9-]*)"/g,
  )) {
    flags.add(m[1]);
  }
  return flags;
}

// --- The CLI's real surface ---

const usageText = [
  formatTopLevelHelp(),
  ...Object.values(SUBCOMMAND_HELP),
].join("\n");

const cliFlags = extractFlagsFromUsageText(usageText);
for (const sourcePath of PARSER_SOURCES) {
  for (const flag of extractFlagsFromParserSource(
    readFileSync(sourcePath, "utf-8"),
  )) {
    cliFlags.add(flag);
  }
}

const indexSource = readFileSync(join(import.meta.dir, "index.ts"), "utf-8");

const cliSubcommands = new Set<string>([
  ...Object.keys(SUBCOMMAND_HELP),
  ...Object.keys(SUBCOMMAND_HELP_ALIASES),
]);
for (const m of formatTopLevelHelp().matchAll(
  /^ {2}plannotator ([a-z][a-z0-9-]*)/gm,
)) {
  cliSubcommands.add(m[1]);
}
// Dispatch sites (`args[0] === "install-runtime"` etc.) cover internal
// subcommands that have no usage entry but that the skill may still name.
for (const m of indexSource.matchAll(/args\[0\] === "([a-z][a-z0-9-]*)"/g)) {
  cliSubcommands.add(m[1]);
}

// --- The skill's documented surface ---

const skillDoc = readFileSync(SKILL_MD_PATH, "utf-8");

const documentedSubcommands = new Set<string>();
for (const fence of skillDoc.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
  for (const m of fence[1].matchAll(/^\s*plannotator\s+([a-z][a-z0-9-]*)/gm)) {
    documentedSubcommands.add(m[1]);
  }
}

const documentedFlags = new Set<string>();
for (const m of skillDoc.matchAll(/(?<![\w-])--[a-z][a-z0-9-]*/g)) {
  documentedFlags.add(m[0]);
}

describe("plannotator knowledge skill freshness", () => {
  test("extractors actually extracted (a parsing regression must not pass vacuously)", () => {
    // If the fence or flag regexes stop matching, the forward assertions
    // below would pass on empty sets. Pin known-present anchors instead of
    // exact counts so the guard survives ordinary edits.
    expect(documentedSubcommands.size).toBeGreaterThanOrEqual(8);
    expect(documentedFlags.size).toBeGreaterThanOrEqual(15);
    expect(cliSubcommands.has("annotate")).toBe(true);
    expect(cliFlags.has("--gate")).toBe(true);
    // --static has no usage-text entry; it must arrive via the parser-source
    // extraction, so its presence proves that leg works.
    expect(cliFlags.has("--static")).toBe(true);
  });

  test("every subcommand the skill documents exists in the CLI", () => {
    for (const sub of documentedSubcommands) {
      expect(
        cliSubcommands.has(sub),
        `SKILL.md documents \`plannotator ${sub}\` but the CLI has no such subcommand — update apps/skills/core/plannotator/SKILL.md`,
      ).toBe(true);
    }
  });

  test("every flag the skill mentions exists in the CLI usage text or arg parsing", () => {
    for (const flag of documentedFlags) {
      expect(
        cliFlags.has(flag),
        `SKILL.md mentions ${flag} but no CLI usage text or parser accepts it — update apps/skills/core/plannotator/SKILL.md`,
      ).toBe(true);
    }
  });

  test("the PLANNOTATOR_ORIGIN row names exactly the origins AGENT_CONFIG defines", () => {
    // #1373 added oh-my-pi and left this row stale. AGENT_CONFIG is the one
    // list of valid origins, so bind the row to it in both directions: a new
    // origin must be added here, and the row may not invent one.
    const row = skillDoc
      .split("\n")
      .find((line) => line.includes("`PLANNOTATOR_ORIGIN`"));
    expect(
      row,
      "SKILL.md no longer has a `PLANNOTATOR_ORIGIN` row — this guard cannot pass vacuously",
    ).toBeDefined();

    const documentedOrigins = new Set(
      [...(row ?? "").matchAll(/`([a-z][a-z0-9-]*)`/g)].map((m) => m[1]),
    );
    for (const origin of Object.keys(AGENT_CONFIG)) {
      expect(
        documentedOrigins.has(origin),
        `AGENT_CONFIG defines the origin \`${origin}\` but the PLANNOTATOR_ORIGIN row in apps/skills/core/plannotator/SKILL.md does not list it`,
      ).toBe(true);
    }
    for (const origin of documentedOrigins) {
      expect(
        origin in AGENT_CONFIG,
        `The PLANNOTATOR_ORIGIN row in apps/skills/core/plannotator/SKILL.md lists \`${origin}\`, which is not an AGENT_CONFIG origin`,
      ).toBe(true);
    }
  });

  test("no user-facing CLI subcommand is missing from the skill", () => {
    // The user-facing surface is what cli.ts publishes help for (plus its
    // aliases and the top-level usage lines). Internal dispatch-only
    // subcommands (opencode-*, copilot-plan, install-runtime) are exempt.
    const userFacing = new Set<string>([
      ...Object.keys(SUBCOMMAND_HELP),
      ...Object.keys(SUBCOMMAND_HELP_ALIASES),
    ]);
    for (const m of formatTopLevelHelp().matchAll(
      /^ {2}plannotator ([a-z][a-z0-9-]*)/gm,
    )) {
      userFacing.add(m[1]);
    }
    for (const sub of userFacing) {
      expect(
        documentedSubcommands.has(sub),
        `CLI subcommand \`plannotator ${sub}\` is not documented in apps/skills/core/plannotator/SKILL.md — add it (a fenced \`plannotator ${sub}\` usage line)`,
      ).toBe(true);
    }
  });
});
