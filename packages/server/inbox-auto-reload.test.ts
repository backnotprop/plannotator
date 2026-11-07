import { describe, expect, test } from "bun:test";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { INBOX_RELOAD_FIELD, parseInboxReloadOffer } from "@plannotator/shared/inbox/connection";
import { claudeSessionOutdated, type ClaudePluginInstall, type LoadedPlugin } from "./inbox-restart";
import { createInboxLiveSessions } from "./inbox-sessions";

// Auto reload (owner approval "cc-auto-reload"): the Inbox tells a Claude Code
// session to reload itself with the SAME judgment Settings → Agents shows
// (`claudeSessionOutdated`), and only when a reload is the fix. The failures
// this catches: an offer to a session a reload cannot help (the installed
// plugin is itself behind this Inbox, a --plugin-dir checkout, another host),
// an offer that outlives the reload (the poll that reports the new version
// must end it, which also takes the session off the manual notice), and a
// poll answer the mod would misread.

const PLUGINS = "/scratch-claude/plugins";
const installAt = (version: string): ClaudePluginInstall => ({
  version,
  installPath: `${PLUGINS}/cache/plannotator/plannotator/${version}`,
  lastUpdated: 2_000,
  scope: "user",
  projectPath: null,
});

function liveWith(records: ClaudePluginInstall[], cliVersion: string) {
  return createInboxLiveSessions({
    store: {} as InboxStore,
    serverSession: "s",
    resolveRoot: async (path) => path,
    outdatedOf: (host, plugin: LoadedPlugin | null, folder) =>
      host === "claude-code" ? claudeSessionOutdated({ loaded: plugin, records, folder, cliVersion, pluginsDir: PLUGINS, changedAt: () => null }) : null,
  });
}

const pluginOf = (version: string, root = `${PLUGINS}/cache/plannotator/plannotator/${version}`) => ({ version, root, loaded_at: 1_000 });

describe("which sessions the Inbox tells to reload", () => {
  test("a Claude Code session running an older plugin than the installed one is told the installed version", async () => {
    const live = liveWith([installAt("0.28.51")], "0.28.51");
    await live.pollStarted("ses-a", "claude-code", { plugin: pluginOf("0.28.50") });
    expect(live.reloadOfferFor("ses-a")).toEqual({ installed: "0.28.51" });
  });

  test("the poll that reports the new version ends the offer (and the manual notice with it)", async () => {
    const live = liveWith([installAt("0.28.51")], "0.28.51");
    await live.pollStarted("ses-a", "claude-code", { plugin: pluginOf("0.28.50") });
    expect(live.restartCount()).toBe(1);
    await live.pollStarted("ses-a", "claude-code", { plugin: pluginOf("0.28.51") });
    expect(live.reloadOfferFor("ses-a")).toBeNull();
    expect(live.restartCount()).toBe(0);
  });

  test("never when a reload cannot help: the installed plugin is behind this Inbox, a checkout, another host, an unknown session", async () => {
    const behind = liveWith([installAt("0.28.50")], "0.28.52");
    await behind.pollStarted("ses-a", "claude-code", { plugin: pluginOf("0.28.49") });
    expect(behind.reloadOfferFor("ses-a")).toBeNull();

    const live = liveWith([installAt("0.28.51")], "0.28.51");
    await live.pollStarted("ses-dir", "claude-code", { plugin: pluginOf("0.28.50", "/home/me/plannotator/apps/hook") });
    expect(live.reloadOfferFor("ses-dir")).toBeNull();
    await live.pollStarted("ses-pi", "pi", { plugin: pluginOf("0.28.50") });
    expect(live.reloadOfferFor("ses-pi")).toBeNull();
    expect(live.reloadOfferFor("ses-never")).toBeNull();
  });
});

describe("the poll answer as the mod reads it", () => {
  test("an offer reads with its version; anything else reads as no offer", () => {
    expect(parseInboxReloadOffer(JSON.stringify({ commands: [], [INBOX_RELOAD_FIELD]: { installed: "0.28.51" } }))).toEqual({ installed: "0.28.51" });
    expect(parseInboxReloadOffer(JSON.stringify({ commands: [], [INBOX_RELOAD_FIELD]: { installed: null } }))).toEqual({ installed: null });
    expect(parseInboxReloadOffer(JSON.stringify({ commands: [] }))).toBeNull();
    expect(parseInboxReloadOffer(JSON.stringify({ [INBOX_RELOAD_FIELD]: "0.28.51" }))).toBeNull();
    expect(parseInboxReloadOffer("not json")).toBeNull();
  });
});
