/**
 * The Qwen Code integration files the installers copy, checked for the
 * things that break Qwen users without failing anywhere else:
 * - the extension's plan-review hook must reach `plannotator` on
 *   exit_plan_mode with a timeout Qwen reads as milliseconds (a value under
 *   1000 is seconds, so a review would be cut off) and name the origin;
 * - the extension must carry no skills: Qwen prefixes extension skills with
 *   the extension name, which would add `/plannotator:plannotator-review`
 *   next to the `/plannotator-review` the installers put in $QWEN_HOME/skills;
 * - each Qwen skill must keep its blocking command out of the shell tool's
 *   foreground limit, and must not use a POSIX env prefix (Qwen on Windows
 *   runs the shell tool under cmd or PowerShell; detection reads Qwen's own
 *   variables instead).
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { AGENT_CONFIG } from "../../packages/core/agents";

const root = import.meta.dir;
const extensionDir = join(root, "extension");

interface HookEntry { type: string; command: string; timeout?: number; env?: Record<string, string> }
interface HookGroup { matcher: string; hooks: HookEntry[] }

function hooks(): Record<string, HookGroup[]> {
  return JSON.parse(readFileSync(join(extensionDir, "hooks", "hooks.json"), "utf8")).hooks;
}

// Each released version of the extension folder, by its tree hash.
const EXTENSION_TREE_HASHES: Record<string, string> = {
  "1.0.0": "df0905f26b1717f8ad89aa6b4235fb48e1e6b9bdcf6c282f29f07285eaa5efaa",
};

// Paths and contents of every file under extension/ (line endings as LF, so
// a Windows checkout hashes the same).
function extensionTreeHash(): string {
  const hash = createHash("sha256");
  const files = (readdirSync(extensionDir, { recursive: true }) as string[])
    .map((file) => file.split(sep).join("/"))
    .filter((file) => statSync(join(extensionDir, file)).isFile())
    .sort();
  for (const file of files) {
    hash.update(`${file}\0${readFileSync(join(extensionDir, file), "utf8").replace(/\r\n/g, "\n")}\0`);
  }
  return hash.digest("hex");
}

describe("Qwen Code extension", () => {
  test("its manifest names the extension the installers and uninstall manage", () => {
    const manifest = JSON.parse(readFileSync(join(extensionDir, "qwen-extension.json"), "utf8"));
    expect(manifest.name).toBe("plannotator");
    expect(typeof manifest.version).toBe("string");
  });

  test("a change to the extension comes with a new version", () => {
    // The installers update an installed extension only when its version
    // differs (`qwen extensions update` is version-based too), so a change
    // without a new version never reaches installed users. Bump "version"
    // in qwen-extension.json and add its hash here. Keep the manifest's name,
    // displayName and description: Qwen asks for consent again on an update
    // that changes them, and the installers' update reads no input.
    const manifest = JSON.parse(readFileSync(join(extensionDir, "qwen-extension.json"), "utf8"));
    expect({ version: manifest.version, hash: extensionTreeHash() }).toEqual({
      version: manifest.version,
      hash: EXTENSION_TREE_HASHES[manifest.version],
    });
  });

  test("exit_plan_mode opens the review and waits long enough", () => {
    const groups = hooks().PermissionRequest;
    const group = groups.find((g) => g.matcher === "exit_plan_mode");
    expect(group).toBeDefined();
    const hook = group!.hooks[0];
    expect(hook.type).toBe("command");
    expect(hook.command).toBe("plannotator");
    // >= 1000 is milliseconds in Qwen; ask for at least a day.
    expect(hook.timeout).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
    expect(hook.env?.PLANNOTATOR_ORIGIN).toBe("qwen-code");
  });

  test("every hook timeout is read the same by old and new Qwen", () => {
    // Qwen before 2026-09-12 read every command-hook timeout as milliseconds;
    // newer Qwen reads 1000 or more as milliseconds and less as seconds. So a
    // value under 1000 (e.g. 5) is 5 ms on an older Qwen.
    for (const groups of Object.values(hooks())) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          expect(hook.timeout).toBeGreaterThanOrEqual(1000);
        }
      }
    }
    const context = hooks().PreToolUse!.find((g) => g.matcher === "enter_plan_mode")!.hooks[0]!;
    expect(context.command).toBe("plannotator improve-context");
    expect(context.timeout).toBe(5000);
  });

  test("every hook names an origin Plannotator knows", () => {
    for (const groups of Object.values(hooks())) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          expect(hook.env?.PLANNOTATOR_ORIGIN && hook.env.PLANNOTATOR_ORIGIN in AGENT_CONFIG).toBe(true);
        }
      }
    }
  });

  test("carries no skills or commands", () => {
    expect(existsSync(join(extensionDir, "skills"))).toBe(false);
    expect(existsSync(join(extensionDir, "commands"))).toBe(false);
  });
});

describe("Qwen Code skills", () => {
  const names = readdirSync(join(root, "skills"));

  test("cover review, annotate and last", () => {
    expect(names.sort()).toEqual(["plannotator-annotate", "plannotator-last", "plannotator-review"]);
  });

  for (const name of names) {
    test(`${name}: user-invoked, run in the background, no env prefix`, () => {
      const text = readFileSync(join(root, "skills", name, "SKILL.md"), "utf8");
      const frontmatter = text.split("---")[1] ?? "";
      expect(frontmatter).toContain(`name: ${name}`);
      expect(frontmatter).toContain("disable-model-invocation: true");
      expect(text).toContain("is_background: true");
      expect(text).not.toMatch(/PLANNOTATOR_ORIGIN=/);
    });
  }
});
