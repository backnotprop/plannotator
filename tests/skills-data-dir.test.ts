/**
 * No shipped skill, command or CLI help names ~/.plannotator as a path to
 * read or write (#2305).
 *
 * The failure this catches: the compound skill told agents to create
 * `~/.plannotator/hooks/compound/...`. On an install that keeps its data
 * under $XDG_DATA_HOME, that made a new ~/.plannotator, and every Plannotator
 * process then used it, so the person's plans and history went out of
 * reach. Agent-facing text must send the agent to `plannotator data-dir`
 * instead. The allowlist holds only text that describes the default (or warns
 * against writing it); every entry must still match, so a stale one fails.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatTopLevelHelp, SUBCOMMAND_HELP } from "../apps/hook/server/cli";

const REPO = resolve(import.meta.dir, "..");

/** A home-relative data-dir path: `~/.plannotator`, `$HOME/.plannotator`, `${HOME}/...`, `%USERPROFILE%\.plannotator`. */
const HARDCODED = /(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)[/\\]\.plannotator/;

/**
 * Where agent instructions ship from: skills, slash commands and agent
 * definitions of every host. Tracked files only (`git ls-files`): builds copy
 * the skills into gitignored folders (apps/pi-extension/skills/,
 * apps/opencode-plugin/skills/), which are generated from these sources and
 * may be stale in a checkout.
 */
function shippedFiles(): string[] {
  const listed = Bun.spawnSync({
    // `:(glob)`: `*` stops at a slash, so `apps/*/commands` is a host's
    // command folder, not apps/marketing/src/content/docs/commands.
    cmd: [
      "git", "ls-files", "-z", "--",
      ":(glob)apps/skills/**", ":(glob).agents/**",
      ":(glob)apps/*/skills/**", ":(glob)apps/*/commands/**", ":(glob)apps/*/agents/**",
    ],
    cwd: REPO,
  });
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
  return listed.stdout
    .toString()
    .split("\0")
    .filter((file) => file && !/\.test\.[cm]?[jt]sx?$/.test(file));
}

/** Text that describes the default data dir, or warns against writing it. `source` is a repo path or `cli:<subcommand>`. */
const ALLOWED: Array<{ source: string; contains: string; why: string }> = [
  {
    source: "apps/skills/core/plannotator/SKILL.md",
    contains: "Never write a path such as `~/.plannotator/...` from memory",
    why: "warns against the hardcoded path",
  },
  {
    source: "apps/skills/core/plannotator/SKILL.md",
    contains: "Unset, the default is `~/.plannotator` or `$XDG_DATA_HOME/plannotator`",
    why: "describes the default and points at plannotator data-dir",
  },
  {
    source: "cli:data-dir",
    contains: "else ~/.plannotator when it exists,",
    why: "the data-dir command's own description of the rule",
  },
  {
    source: "cli:data-dir",
    contains: "~/.plannotator.",
    why: "the data-dir command's own description of the rule",
  },
  {
    source: "cli:data-dir",
    contains: "Agents: use this path instead of writing ~/.plannotator.",
    why: "warns against the hardcoded path",
  },
];

type Hit = { source: string; line: string };

function hitsIn(source: string, text: string): Hit[] {
  return text
    .split("\n")
    .filter((line) => HARDCODED.test(line))
    .map((line) => ({ source, line }));
}

function allHits(): Hit[] {
  const hits: Hit[] = [];
  for (const file of shippedFiles()) hits.push(...hitsIn(file, readFileSync(join(REPO, file), "utf8")));
  hits.push(...hitsIn("cli:--help", formatTopLevelHelp({ board: true })));
  for (const [sub, text] of Object.entries(SUBCOMMAND_HELP)) hits.push(...hitsIn(`cli:${sub}`, text));
  return hits;
}

describe("shipped agent instructions never hardcode the data directory", () => {
  const hits = allHits();

  test("the scan reaches the skills it guards", () => {
    // The compound skill is the one that broke installs; if the walk stops
    // reaching it, every other assertion here passes vacuously.
    const files = shippedFiles();
    expect(files).toContain("apps/skills/extra/plannotator-compound/SKILL.md");
    expect(files).toContain("apps/skills/core/plannotator/SKILL.md");
    expect(files).toContain("apps/kiro-cli/skills/plannotator-review/SKILL.md");
    expect(files).toContain("apps/opencode-plugin/commands/plannotator-review.md");
  });

  test("every mention is an allowlisted description of the default", () => {
    const unexpected = hits.filter(
      (hit) => !ALLOWED.some((entry) => entry.source === hit.source && hit.line.includes(entry.contains)),
    );
    expect(
      unexpected,
      "Agent-facing text names ~/.plannotator. Send the agent to `plannotator data-dir` (or say `<data-dir>`) instead; on an XDG install a new ~/.plannotator hides the person's data (#2305).",
    ).toEqual([]);
  });

  test("every allowlist entry still matches a line", () => {
    const stale = ALLOWED.filter(
      (entry) => !hits.some((hit) => hit.source === entry.source && hit.line.includes(entry.contains)),
    );
    expect(stale).toEqual([]);
  });
});
