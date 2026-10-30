/**
 * The e2e agent CLI stubs (tests/e2e/agent-cli-stubs.ts) cover every agent
 * CLI a Plannotator server can look up or spawn, and every e2e spec that
 * builds its own PATH gives its Inbox the test sandbox. A registry that gains
 * a CLI, or a new spec with a PATH of its own, fails here until it is covered.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { AGENT_SPECS, type AgentEnvironment } from "../packages/server/inbox-agents";
import { MARKER_ENGINES } from "../packages/server/marker-review";
import { AGENT_CLIS, agentCliCalls, writeAgentCliStubs } from "./e2e/agent-cli-stubs";

const repoRoot = resolve(import.meta.dir, "..");
const stubbed = new Set<string>(AGENT_CLIS);
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Tools the servers look up that are not agents: never stubbed (git, openssl and the rest must keep working). */
const NOT_AGENTS = new Set(["node", "npm", "glimpseui", "dns-sd", "avahi-publish", "openssl", "git", "curl", "lsof", "rg", "pwsh", "pwsh.exe", "powershell.exe", "tailscale", "sh", "bash"]);

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "vendor") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) found.push(path);
  }
  return found;
}

describe("the agent CLI stubs cover", () => {
  test("the Inbox's agents (AGENT_SPECS): every name they look up or remove with", async () => {
    const looked = new Set<string>();
    const home = mkdtempSync(join(tmpdir(), "agent-cli-stubs-home-"));
    tempDirs.push(home);
    const e: AgentEnvironment = {
      platform: "darwin",
      homeDir: home,
      env: { HOME: home, PATH: "" },
      which: (command) => {
        looked.add(command);
        return null;
      },
      run: () => {
        throw new Error("nothing runs here");
      },
    };
    for (const spec of AGENT_SPECS) {
      spec.detect(e);
      await spec.way(e, false);
      if (spec.remove) looked.add(spec.remove.bin);
    }
    expect(looked.size).toBeGreaterThan(5);
    expect([...looked].filter((name) => !stubbed.has(name))).toEqual([]);
  });

  test("the review engines (MARKER_ENGINES), their other names included", () => {
    const names = Object.values(MARKER_ENGINES).flatMap((engine) => [engine.binary, ...(engine.altBinaries ?? [])]);
    expect(names).toContain("copilot");
    expect(names.filter((name) => !stubbed.has(name))).toEqual([]);
  });

  test("the agent terminal's built-in agents (BUILT_IN_AGENTS)", async () => {
    const core = (await import(Bun.resolveSync("@plannotator/webtui/core", join(repoRoot, "packages/server")))) as typeof import("@plannotator/webtui/core");
    const names = core.listBuiltInAgents().map((id) => core.BUILT_IN_AGENTS[id].detectCommand);
    expect(names.length).toBeGreaterThan(10);
    expect(names.filter((name) => !stubbed.has(name))).toEqual([]);
  });

  test("uninstall's plugin removals", () => {
    const source = readFileSync(join(repoRoot, "packages/server/uninstall.ts"), "utf8");
    const names = [...source.matchAll(/\bcommand:\s*"([\w.-]+)"/g)].map((m) => m[1]!);
    expect(names).toContain("droid");
    expect(names.filter((name) => !stubbed.has(name))).toEqual([]);
  });

  test("every name a server looks up on PATH by a literal (Bun.which, onPath), or it is a known non-agent tool", () => {
    const roots = ["packages/server", "packages/ai", "packages/shared", "apps/hook/server", "apps/pi-extension/server"].map((dir) => join(repoRoot, dir));
    const missing: string[] = [];
    let seen = 0;
    for (const file of roots.flatMap((dir) => sourceFiles(dir))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/\b(?:which|onPath)\(\s*["'`]([\w.-]+)["'`]/g)) {
        seen++;
        const name = match[1]!;
        if (!stubbed.has(name) && !NOT_AGENTS.has(name)) missing.push(`${relative(repoRoot, file)}: ${name}`);
      }
    }
    expect(seen).toBeGreaterThan(10);
    expect(missing).toEqual([]);
  });
});

describe("a stub", () => {
  test.skipIf(process.platform === "win32")("records its call and answers no version, so nothing takes it for a usable CLI", () => {
    const dir = writeAgentCliStubs(join(mkdtempSync(join(tmpdir(), "agent-cli-stubs-")), "bin"));
    tempDirs.push(resolve(dir, ".."));
    const run = spawnSync(join(dir, "codex"), ["--version"], { encoding: "utf8" });
    expect(run.status).toBe(127);
    expect(run.stdout).toBe("");
    expect(agentCliCalls(dir)).toEqual(["codex --version"]);
  });
});

/**
 * Specs that need the agents they set up under HOME found (the sandbox would hide them), so their PATH holds only
 * their own folder and the system's /usr/bin:/bin, never a folder that holds agents.
 */
const OWN_FAKES = new Set(["inbox-first-run.spec.ts", "inbox.spec.ts"]);

describe("an e2e spec that builds its own PATH", () => {
  test("gives that Inbox the test sandbox (or keeps the runner's PATH, where the stubs come first)", () => {
    const dir = join(repoRoot, "tests/e2e");
    const unguarded: string[] = [];
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const lines = readFileSync(join(dir, name), "utf8").split("\n");
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return;
        const at = line.indexOf("PATH:");
        if (at < 0 || /\w$/.test(line.slice(0, at))) return;
        if (line.slice(at).includes("process.env.PATH")) return;
        // The env literal: this line when it closes here, else the next lines up to its close.
        const end = /}\s*[;,)]*\s*$/.test(line) ? i : lines.findIndex((l, j) => j > i && /^\s*}/.test(l));
        const literal = lines.slice(i, end < 0 ? i + 1 : end + 1).join("\n");
        if (literal.includes("PLANNOTATOR_TEST_SANDBOX") || OWN_FAKES.has(name)) return;
        unguarded.push(`tests/e2e/${name}:${i + 1}`);
      });
    }
    expect(unguarded).toEqual([]);
  });
});
