import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { claudeSessionOutdated, createClaudePluginInstallReader } from "./inbox-restart";
import { createInboxLiveSessions } from "./inbox-sessions";

// #3623: every list read, the 5 s restart watch and every poll answer judge every live Claude Code session again, and
// the judgment compares real paths. A session started on another machine names folders this one does not have
// (`/home/<user>/...`, which macOS sends through the automount at 20-60 ms a lookup), so resolving them on each read
// made the thread list take seconds. Each path is resolved once until the registry changes.

const VERSION = "0.28.70";

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-restart-paths-")));
  const claudeDir = join(root, "claude");
  const pluginsDir = join(claudeDir, "plugins");
  const folderOf = (version: string) => join(pluginsDir, "cache", "plannotator", "plannotator", version);
  const install = (version: string) => {
    mkdirSync(join(folderOf(version), ".claude-plugin"), { recursive: true });
    writeFileSync(join(folderOf(version), ".claude-plugin", "plugin.json"), JSON.stringify({ version }));
    writeFileSync(
      join(pluginsDir, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "plannotator@plannotator": [{ scope: "user", version, installPath: folderOf(version), lastUpdated: "2026-11-01T00:00:00Z" }] } }),
    );
  };
  install(VERSION);
  const calls: string[] = [];
  let clock = 1_000_000;
  const reader = createClaudePluginInstallReader(
    createAgentEnvironmentFor({ platform: process.platform, homeDir: root, env: { HOME: root, CLAUDE_CONFIG_DIR: claudeDir, PATH: "" } }),
    () => clock,
    {
      realpath: (path) => {
        calls.push(path);
        return realpathSync(path);
      },
    },
  );
  const live = createInboxLiveSessions({
    store: InboxStore.open(join(root, "data")),
    serverSession: "s",
    resolveRoot: async (path) => path,
    // As the Inbox wires it (inbox.ts).
    outdatedOf: (host, plugin, folder) =>
      host === "claude-code"
        ? claudeSessionOutdated({ loaded: plugin, records: reader.records(), folder, cliVersion: VERSION, pluginsDir: reader.pluginsDir(), changedAt: reader.changedAt, realPath: reader.realPath })
        : null,
  });
  return {
    root,
    folderOf,
    install,
    calls,
    live,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe("the restart judgment's real paths (#3623)", () => {
  test("a repeated list read resolves no path again, until an update rewrites the registry", async () => {
    const box = sandbox();
    try {
    // A session on this machine one release behind, and one started on another machine (folders this one lacks).
    await box.live.pollStarted("ses-here", "claude-code", { plugin: { version: "0.28.69", root: box.folderOf("0.28.69"), loaded_at: 1_000 } });
    const away = join(box.root, "other-machine", "home", "dev");
    await box.live.pollStarted("ses-away", "claude-code", {
      plugin: { version: "0.28.60", root: join(away, ".claude", "plugins", "cache", "plannotator", "plannotator", "0.28.60"), loaded_at: 1_000 },
      session_folder: join(away, "project"),
    });

    expect(box.live.restartAgents()).toEqual({ total: 1, runtimes: { "claude-code": 1 } });
    expect(box.calls.some((path) => path.startsWith(away))).toBe(true);
    const first = box.calls.length;

    // Later reads, past the registry's 2 s reuse (it is read again, unchanged): the list, the thread's session
    // route, a poll answer, Settings → Agents. Same answers, no path resolved again.
    for (let i = 0; i < 3; i++) {
      box.tick(5_000);
      expect(box.live.restartAgents()).toEqual({ total: 1, runtimes: { "claude-code": 1 } });
      expect(box.live.connectionOf("ses-away")?.outdated).toBeNull();
      expect(box.live.reloadOfferFor("ses-here")).toEqual({ installed: VERSION });
    }
    expect(box.calls.length).toBe(first);

    // An update into a new folder rewrites the registry: the paths are resolved again, and the judgment follows it.
    box.install("0.28.71");
    box.tick(5_000);
    expect(box.live.reloadOfferFor("ses-here")).toEqual({ installed: "0.28.71" });
    expect(box.calls.length).toBeGreaterThan(first);
    } finally {
      rmSync(box.root, { recursive: true, force: true });
    }
  });
});
