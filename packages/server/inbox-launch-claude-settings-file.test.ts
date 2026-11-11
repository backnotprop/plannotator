import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSettingsFilePath, claudeSettingsSignIn, mergeClaudeLaunchSettings, readClaudeSettingsFile } from "./inbox-launch-claude-settings-file";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// What the Inbox writes for every launch (inbox-launch-claude.ts `writeSettings`), in short.
const OURS = {
  env: { PATH: "/login/bin", PLANNOTATOR_LAUNCH: "lch_1", PLANNOTATOR_LAUNCH_KEY: "k" },
  enableAllProjectMcpServers: true,
  permissions: { allow: ["mcp__plannotator__plannotator_inbox"], defaultMode: "default" },
  hooks: { PermissionRequest: [{ matcher: "*", hooks: [{ type: "command", command: "plannotator inbox permission-hook" }] }] },
};

test("the person's settings go under the Inbox's: env merged name by name, both allow lists and hook lists kept, ours win a clash", () => {
  const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ["nothing of theirs", {}, OURS],
    [
      "a gateway profile",
      { apiKeyHelper: "~/bin/gateway-key", env: { ANTHROPIC_BASE_URL: "https://llm.corp.example", PATH: "/theirs" }, model: "sonnet" },
      { ...OURS, apiKeyHelper: "~/bin/gateway-key", model: "sonnet", env: { ANTHROPIC_BASE_URL: "https://llm.corp.example", ...OURS.env } },
    ],
    [
      "their rules and hooks",
      { permissions: { allow: ["Bash(npm test)", "mcp__plannotator__plannotator_inbox"], deny: ["Read(.env)"], defaultMode: "plan" }, hooks: { PermissionRequest: [{ matcher: "Bash" }], Stop: [{ matcher: "" }] } },
      {
        ...OURS,
        permissions: { allow: ["Bash(npm test)", "mcp__plannotator__plannotator_inbox"], deny: ["Read(.env)"], defaultMode: "default" },
        hooks: { PermissionRequest: [{ matcher: "Bash" }, ...OURS.hooks.PermissionRequest], Stop: [{ matcher: "" }] },
      },
    ],
    ["a wrong shape gives way", { env: "not an object", hooks: ["x"], permissions: null, enableAllProjectMcpServers: false }, OURS],
  ];
  for (const [name, person, merged] of cases) expect(mergeClaudeLaunchSettings(person, OURS), name).toEqual(merged);
});

test("the file at start: a ~ or relative path is home's; missing, not JSON or not an object says so with the path only", () => {
  const home = mkdtempSync(join(tmpdir(), "plannotator-claude-settings-file-"));
  dirs.push(home);
  mkdirSync(join(home, "profiles"));
  expect(claudeSettingsFilePath("~/profiles/gateway.json", home)).toBe(join(home, "profiles", "gateway.json"));
  expect(claudeSettingsFilePath("profiles/gateway.json", home)).toBe(join(home, "profiles", "gateway.json"));
  expect(claudeSettingsFilePath("/etc/claude/gateway.json", home)).toBe("/etc/claude/gateway.json");
  const file = (name: string, text: string) => {
    writeFileSync(join(home, "profiles", name), text);
    return readClaudeSettingsFile(join(home, "profiles", name), `~/profiles/${name}`);
  };
  expect(file("ok.json", '{"apiKeyHelper":"secret-helper"}')).toEqual({ ok: true, settings: { apiKeyHelper: "secret-helper" } });
  const refused: [ReturnType<typeof readClaudeSettingsFile>, string][] = [
    [readClaudeSettingsFile(join(home, "nope.json"), "~/nope.json"), "Your Claude settings file ~/nope.json isn't there. Fix it in Settings → Agents, or clear it there."],
    [file("bad.json", '{"apiKeyHelper": "secret-helper",'), "Your Claude settings file ~/profiles/bad.json isn't valid JSON. Fix it in Settings → Agents, or clear it there."],
    [file("list.json", '["secret-helper"]'), "Your Claude settings file ~/profiles/list.json isn't valid JSON. Fix it in Settings → Agents, or clear it there."],
    [readClaudeSettingsFile(join(home, "profiles"), "~/profiles"), "Your Claude settings file ~/profiles isn't a settings file. Fix it in Settings → Agents, or clear it there."],
  ];
  for (const [read, words] of refused) {
    expect(read).toEqual({ ok: false, text: words });
    // Never a word of what is inside.
    expect(JSON.stringify(read)).not.toContain("secret-helper");
  }
});

test("a file that signs in by itself (key helper, token, gateway, cloud) lets a signed-out check pass; an empty value does not", () => {
  expect(claudeSettingsSignIn({ apiKeyHelper: "~/bin/key" })).toBe(true);
  expect(claudeSettingsSignIn({ env: { ANTHROPIC_BASE_URL: "https://llm.corp.example" } })).toBe(true);
  expect(claudeSettingsSignIn({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } })).toBe(true);
  expect(claudeSettingsSignIn({ apiKeyHelper: " ", env: { ANTHROPIC_API_KEY: "" } })).toBe(false);
  expect(claudeSettingsSignIn({ model: "opus" })).toBe(false);
});
