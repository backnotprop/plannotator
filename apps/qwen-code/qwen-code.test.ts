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

const EXTENSION_TREE_HASHES: Record<string, string> = {
  "1.0.0": "df0905f26b1717f8ad89aa6b4235fb48e1e6b9bdcf6c282f29f07285eaa5efaa",
};

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
    expect(hook.timeout).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
    expect(hook.env?.PLANNOTATOR_ORIGIN).toBe("qwen-code");
  });

  test("every hook timeout is read the same by old and new Qwen", () => {
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
