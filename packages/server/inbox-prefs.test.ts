/**
 * POST and GET /api/inbox/prefs over stand-in routes (inbox-prefs.ts alone; the real routes are in
 * inbox-prefs-route.test.ts). What regresses: several keys reaching their route as more than one settings call, or
 * in pieces that undo each other (two theme halves, a sidebar part over another); a bad value, an unknown key or a
 * guest's owner-only key reaching any route; a route's refusal not saying what an earlier route already wrote; Settings
 * → Agents' 200-with-error read as done; a held switch or a guest's owner-only key offered in the list; the group
 * filter; a route body not mapped back to the keys `event: prefs` names.
 */
import { describe, expect, test } from "bun:test";
import { INBOX_SIDEBAR_DEFAULT } from "@plannotator/core/inbox-sidebar";
import { inboxPrefKeysOf, inboxPrefsCatalogue, inboxPrefsPost, type InboxPrefsSources } from "./inbox-prefs";

type Json = Record<string, any>;

function sources(settings: Json = {}, config: Json = {}, agents: Json[] | null = null): InboxPrefsSources {
  return {
    settings: { theme: { mode: "dark", light: "plannotator", dark: "plannotator" }, text_size: 14, sidebar: null, sound: { enabled: true, volume: 60 }, board: { on: false }, steps: { on: false }, launch: { enabled: true, full_permissions: false, settings_file: null }, ...settings },
    config: config as InboxPrefsSources["config"],
    agents,
  };
}

function routes(answers: Record<string, { status: number; body: Json }> = {}) {
  const calls: { path: string; body: Json }[] = [];
  return {
    calls,
    deps: (s: InboxPrefsSources) => ({
      read: async () => s,
      dispatch: async (path: string, body: Json) => {
        calls.push({ path, body });
        return answers[path] ?? { status: 200, body: {} };
      },
    }),
  };
}

describe("a write", () => {
  test("several settings keys go in one settings call, the theme's halves together", async () => {
    const r = routes();
    const answer = await inboxPrefsPost({ set: { "appearance.theme": "light", "appearance.dark_palette": "plannotator-graphite", "appearance.text_size": 15, "sound.volume": 40 } }, true, r.deps(sources()));
    expect(answer.status).toBe(200);
    expect(r.calls).toEqual([{ path: "/api/inbox/settings", body: { theme: { mode: "light", dark: "plannotator-graphite" }, text_size: 15, sound: { volume: 40 } } }]);
    expect(answer.saved).toEqual(["appearance.theme", "appearance.dark_palette", "appearance.text_size", "sound.volume"]);
  });

  test("the sidebar's parts are applied over the layout now, and over each other", async () => {
    const r = routes();
    await inboxPrefsPost({ set: { "sidebar.hidden": ["usage"], "sidebar.bottom": ["board", "settings"] } }, true, r.deps(sources()));
    const layout = r.calls[0]!.body.sidebar;
    expect(layout.hidden).toEqual(["usage"]);
    expect(layout.bottom).toEqual(["board", "settings"]);
    expect(layout.top).toEqual(INBOX_SIDEBAR_DEFAULT.top.filter((id) => id !== "board"));
  });

  test("one bad value or an unknown key reaches no route", async () => {
    for (const set of [{ "appearance.theme": "light", "sound.volume": 5 }, { "appearance.theme": "light", "list.font": "serif" }]) {
      const r = routes();
      const answer = await inboxPrefsPost({ set }, true, r.deps(sources()));
      expect(answer.status).toBeGreaterThanOrEqual(403);
      expect(r.calls).toEqual([]);
    }
  });

  test("a tailnet guest's owner-only key refuses the call before any route runs", async () => {
    const r = routes();
    const answer = await inboxPrefsPost({ set: { "appearance.theme": "light", "capabilities.board": true } }, false, r.deps(sources()));
    expect(answer).toMatchObject({ status: 403, body: { code: "owner_only", key: "capabilities.board" } });
    expect(r.calls).toEqual([]);
    // The keys its routes let a guest change still go.
    const ok = routes();
    expect((await inboxPrefsPost({ set: { "appearance.theme": "light" } }, false, ok.deps(sources()))).status).toBe(200);
  });

  test("routes run settings first, launch's switch before its folder, and a refusal says what was saved", async () => {
    const r = routes({ "/api/inbox/settings/decisions-post": { status: 500, body: { error: "config.json could not be saved", code: "config_not_saved" } } });
    const answer = await inboxPrefsPost({ set: { "launch.scratch_dir": "~/scratch", "decisions.post_to": "both", "launch.on": true, "appearance.text_size": 13 } }, true, r.deps(sources()));
    expect(r.calls.map((c) => c.path)).toEqual(["/api/inbox/settings", "/api/inbox/launch/settings", "/api/inbox/launch/settings", "/api/inbox/settings/decisions-post"]);
    expect(r.calls[1]!.body).toEqual({ enabled: true });
    expect(answer).toMatchObject({ status: 500, body: { code: "config_not_saved", keys: ["decisions.post_to"], saved: ["appearance.text_size", "launch.on", "launch.scratch_dir"] } });
  });

  test("Settings → Agents' switch that did not hold is a refusal", async () => {
    const agents = [{ id: "codex", reach: { on: false, kind: "mcp" } }];
    const r = routes({ "/api/inbox/agents": { status: 200, body: { error: "Codex was not found on this computer" } } });
    const answer = await inboxPrefsPost({ set: { "agents.codex.reach": true } }, true, r.deps(sources({}, {}, agents)));
    expect(r.calls).toEqual([{ path: "/api/inbox/agents", body: { agent: "codex", reach: true } }]);
    expect(answer).toMatchObject({ status: 422, body: { code: "agent_not_changed" }, saved: [] });
  });

  test("the window's serverSession and an agent's name ride along", async () => {
    const r = routes();
    await inboxPrefsPost({ set: { "list.rows": ["compact"] }, by: { host: "pi", session: "s1" }, serverSession: "abc" }, true, r.deps(sources()));
    expect(r.calls[0]!.body).toEqual({ rows: ["compact"], rows_by: { host: "pi", session: "s1" }, serverSession: "abc" });
  });

  test("the logins go before the window over the tailnet turns on; launch's full permissions and settings file are written", async () => {
    const r = routes();
    const answer = await inboxPrefsPost({ set: { "access.tailnet_window": true, "access.tailnet_allow": ["friend@example.com"], "launch.full_permissions": true, "launch.settings_file": "~/claude.json" } }, true, r.deps(sources()));
    expect(answer.status).toBe(200);
    expect(r.calls).toEqual([
      { path: "/api/inbox/settings/tailscale-allow", body: { allow: ["friend@example.com"] } },
      { path: "/api/inbox/settings", body: { tailscale: { on: true } } },
      { path: "/api/inbox/launch/settings", body: { full_permissions: true } },
      { path: "/api/inbox/launch/settings", body: { settings_file: "~/claude.json" } },
    ]);
  });

  test("the phones' doors and a cloud agent's wake go to their own routes; a guest reaches none of them", async () => {
    const s = { ...sources(), devices: { lan: false, tailnet: false }, cloud: [{ session: "cloud.0123456789ab", name: "Nightly fixer", preset: "grok-bot", wake: false }] };
    const r = routes();
    const wake = { url: "https://example.com/hook", key: "secret-1234" };
    const answer = await inboxPrefsPost({ set: { "access.this_wifi": true, "access.tailnet_door": true, "cloud_agents.0123456789ab.wake": wake } }, true, r.deps(s));
    expect(answer.status).toBe(200);
    expect(r.calls).toEqual([
      { path: "/api/inbox/lan", body: { on: true } },
      { path: "/api/inbox/tailnet", body: { on: true } },
      { path: "/api/inbox/cloud-agents/cloud.0123456789ab/wake", body: wake },
    ]);
    expect(JSON.stringify(answer.body)).not.toContain("secret-1234");
    for (const key of ["access.this_wifi", "access.tailnet_allow", "voice.api_key", "cloud_agents.0123456789ab.wake"]) {
      const guest = routes();
      expect((await inboxPrefsPost({ set: { [key]: key === "access.tailnet_allow" ? [] : key === "voice.api_key" ? "sk-a-real-looking-key" : key.startsWith("cloud") ? wake : true } }, false, guest.deps(s))).status).toBe(403);
      expect(guest.calls).toEqual([]);
    }
  });

  test("a secret is listed as set or not set, never its value", () => {
    const s = { ...sources({ voice: { on: true, key: { source: "saved", last4: "1234" } } }), cloud: [{ session: "cloud.0123456789ab", name: "Nightly fixer", preset: "grok-bot", wake: true }] };
    const list = inboxPrefsCatalogue(s, true, null).prefs;
    expect(list.find((p) => p.key === "voice.api_key")).toMatchObject({ value: "set", secret: true });
    expect(list.find((p) => p.key === "cloud_agents.0123456789ab.wake")).toMatchObject({ value: "set", secret: true, label: "Nightly fixer's wake address and key" });
    expect(JSON.stringify(list)).not.toContain("1234\"");
  });

  test("a held switch is not offered, and its write is refused", async () => {
    const r = routes();
    const answer = await inboxPrefsPost({ set: { "capabilities.code_review": true } }, true, r.deps(sources()));
    expect(answer).toMatchObject({ status: 409, body: { code: "pref_unavailable" } });
    expect(r.calls).toEqual([]);
  });
});

describe("the list", () => {
  test("values now, the group filter, and what a guest is offered", () => {
    const s = sources({ text_size: 13, cookie_host: { on: true } });
    const all = inboxPrefsCatalogue(s, true, null);
    expect(all.prefs.find((p) => p.key === "appearance.text_size")).toMatchObject({ value: 13, default: 14, allowed: "12, 13, 14 or 15", scope: "person" });
    expect(all.prefs.find((p) => p.key === "launch.full_permissions")).toMatchObject({ value: false });
    // Held (absent from the settings answer) and the agents (not read): not listed.
    expect(all.prefs.some((p) => p.key === "capabilities.code_review" || p.key.startsWith("agents."))).toBe(false);
    expect(inboxPrefsCatalogue(s, true, "sound").prefs.map((p) => p.key)).toEqual(["sound.on", "sound.volume"]);
    const guest = inboxPrefsCatalogue(s, false, null).prefs.map((p) => p.key);
    expect(guest).toContain("appearance.theme");
    expect(guest).not.toContain("capabilities.board");
    expect(guest).not.toContain("general.plannotator_localhost");
  });
});

describe("event: prefs", () => {
  test("a route's body names the keys it touched", () => {
    expect(inboxPrefKeysOf("settings", { theme: { mode: "dark" }, text_size: 13 }).sort()).toEqual(["appearance.dark_palette", "appearance.light_palette", "appearance.text_size", "appearance.theme"]);
    expect(inboxPrefKeysOf("settings", { diff_style: "split" })).toContain("diff.style");
    expect(inboxPrefKeysOf("settings", { reaction_change: { op: "add", emoji: "🎉" } })).toEqual(["reactions.saved"]);
    expect(inboxPrefKeysOf("agents", { agent: "pi", reminder: false })).toEqual(["agents.pi.reminder"]);
    expect(inboxPrefKeysOf("launch", { enabled: false })).toEqual(["launch.on"]);
  });
});
