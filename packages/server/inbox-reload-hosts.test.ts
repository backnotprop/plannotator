/**
 * Pi, Oh My Pi and OpenCode 2 after an update (owner approval "reload-hosts"):
 * which command loads the newer Plannotator in each runtime. First the rules
 * alone (packages/server/inbox-restart.ts), then over a real Inbox (temp data
 * dir, scratch HOME and Pi agent dir): a poll's `plugin: { version, on_disk,
 * host }` reaches the sessions route's `asker.connection.outdated`, Settings →
 * Agents' `sessions`, and the list model's `restart_agents`; the shared
 * `InboxWake` sends what its host reports; and the `tag_needs_update`
 * refusal names the host's own command. Nothing reads the real ~/.pi or ~/.plannotator.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxAgentsModel, InboxSessionOutdated } from "@plannotator/core/inbox-types";
import { InboxAgentConnection, InboxWake } from "@plannotator/shared/inbox/agent-link";
import { INBOX_BRIDGE_POLL_PATH, INBOX_WAKES_META_KEY } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";
import { createAgentEnvironmentFor } from "./inbox-agents";
import {
  OMP_RESTART_COMMAND,
  OMP_UPGRADE_COMMAND,
  OPENCODE2_RELOAD_COMMAND,
  OPENCODE2_SERVICE_RESTART_COMMAND,
  createOpenCodeSpecReader,
  openCodePluginSpec,
  openCodeSessionOutdated,
  openCodeSpecPinned,
  opencodePluginUpdateCommand,
  parseLoadedPlugin,
  PI_INSTALL_LATEST_COMMAND,
  PI_RELOAD_COMMAND,
  PI_UPDATE_COMMAND,
  piExtensionPinned,
  piSessionOutdated,
  runtimeOf,
  tagUpdateFix,
} from "./inbox-restart";

const plugin = (body: Record<string, unknown>) => parseLoadedPlugin(body);

describe("the judgment table", () => {
  test("parseLoadedPlugin: on_disk a version, null (gone), or absent (an older connection); host oh-my-pi or pi", () => {
    expect(plugin({ version: "0.28.30", on_disk: "0.28.31", host: "oh-my-pi" })).toMatchObject({ version: "0.28.30", onDisk: "0.28.31", host: "oh-my-pi" });
    expect(plugin({ version: "0.28.30", on_disk: null })).toMatchObject({ onDisk: null });
    expect("onDisk" in plugin({ version: "0.28.30" })!).toBe(false);
    // Anything else counts as not sent: never read as "gone".
    expect("onDisk" in plugin({ version: "0.28.30", on_disk: 7 })!).toBe(false);
    expect("host" in plugin({ version: "0.28.30", host: "codex" })!).toBe(false);
  });

  test("Pi: the package changed on disk under the session → /reload, whatever the Inbox's version", () => {
    expect(piSessionOutdated(plugin({ version: "0.28.30", on_disk: "0.28.31", host: "pi" }), "dev")).toEqual({
      loaded: "0.28.30",
      installed: "0.28.31",
      fix: "reload",
      runtime: "pi",
      reload_command: PI_RELOAD_COMMAND,
      reload_where: "session",
    });
  });

  test("Pi: on disk = loaded, behind this Inbox → pi update --extensions, then /reload (pinned: pi install)", () => {
    const behind = plugin({ version: "0.28.29", on_disk: "0.28.29", host: "pi" });
    expect(piSessionOutdated(behind, "0.28.31")).toMatchObject({ fix: "update_extension", update_command: PI_UPDATE_COMMAND, reload_command: PI_RELOAD_COMMAND, runtime: "pi" });
    expect(piSessionOutdated(behind, "0.28.31", { pinned: true })).toMatchObject({ fix: "update_extension", update_command: PI_INSTALL_LATEST_COMMAND });
    expect(piSessionOutdated(behind, "0.28.29")).toBeNull();
    expect(piSessionOutdated(behind, "dev")).toBeNull();
  });

  test("Oh My Pi: /restart, and omp plugin upgrade first when the files are behind too", () => {
    expect(piSessionOutdated(plugin({ version: "0.28.30", on_disk: "0.28.31", host: "oh-my-pi" }), "0.28.31")).toMatchObject({
      fix: "reload",
      runtime: "oh-my-pi",
      reload_command: OMP_RESTART_COMMAND,
    });
    expect(piSessionOutdated(plugin({ version: "0.28.29", on_disk: "0.28.29", host: "oh-my-pi" }), "0.28.31", { pinned: true })).toMatchObject({
      fix: "update_extension",
      runtime: "oh-my-pi",
      update_command: OMP_UPGRADE_COMMAND,
      reload_command: OMP_RESTART_COMMAND,
    });
  });

  test("Pi: gone from disk says nothing; an older connection (no on_disk) keeps the old rule", () => {
    expect(piSessionOutdated(plugin({ version: "0.28.30", on_disk: null, host: "pi" }), "0.28.31")).toBeNull();
    expect(piSessionOutdated(plugin({ version: "0.28.20" }), "0.28.25")).toEqual({ loaded: "0.28.20", installed: "0.28.25", fix: "update_extension" });
  });

  test("OpenCode 2: a deleted generation → opencode2 reload; behind the Inbox with the files there → opencode2 plugin update <the configured spec>", () => {
    const base = { runtime: "opencode", reload_where: "shell", fallback_command: OPENCODE2_SERVICE_RESTART_COMMAND };
    expect(openCodeSessionOutdated(plugin({ version: "0.28.31", on_disk: null }), "0.28.31")).toEqual({
      loaded: "0.28.31",
      installed: null,
      fix: "reload",
      reload_command: OPENCODE2_RELOAD_COMMAND,
      ...base,
    } as InboxSessionOutdated);
    // Behind, the configured spec known: only Plannotator updates (OpenCode wants the spec exactly as configured).
    const behind = plugin({ version: "0.28.29", on_disk: "0.28.29" });
    const named = openCodeSessionOutdated(behind, "0.28.31", { spec: "@plannotator/opencode@latest" })!;
    expect(named).toMatchObject({ fix: "update_extension", update_command: "opencode2 plugin list && opencode2 plugin update @plannotator/opencode@latest", ...base });
    expect(named.update_scope).toBeUndefined();
    // The spec unknown: no target, and the window says it updates every outdated plugin.
    expect(openCodeSessionOutdated(behind, "0.28.31")).toMatchObject({ fix: "update_extension", update_command: "opencode2 plugin list && opencode2 plugin update", update_scope: "all" });
    // Pinned to an exact version: plugin update is a no-op, so the pin changes and the service reloads.
    const pinned = openCodeSessionOutdated(behind, "0.28.31", { spec: "@plannotator/opencode@0.28.29" })!;
    expect(pinned).toMatchObject({ fix: "update_extension", pinned_spec: "@plannotator/opencode@0.28.29", pin_to: "@plannotator/opencode@latest", reload_command: OPENCODE2_RELOAD_COMMAND });
    expect(pinned.update_command).toBeUndefined();
    expect(openCodeSessionOutdated(plugin({ version: "0.28.31", on_disk: "0.28.31" }), "0.28.31")).toBeNull();
    // An older OpenCode connection sends no plugin: nothing to say.
    expect(openCodeSessionOutdated(null, "0.28.31")).toBeNull();
    expect(openCodeSessionOutdated(plugin({ version: "0.28.29" }), "0.28.31")).toBeNull();
  });

  test("OpenCode 2's configured spec, as written; a pin is an exact version", () => {
    expect(openCodePluginSpec(JSON.stringify({ plugins: [{ package: "@plannotator/opencode@latest", options: {} }] }))).toBe("@plannotator/opencode@latest");
    expect(openCodePluginSpec(JSON.stringify({ plugins: ["other-plugin", "@plannotator/opencode"] }))).toBe("@plannotator/opencode");
    // OpenCode 1's key, which OpenCode 2 also reads and our installer writes: a string, or a [spec, options] pair.
    expect(openCodePluginSpec(JSON.stringify({ plugin: ["@plannotator/opencode@latest"] }))).toBe("@plannotator/opencode@latest");
    expect(openCodePluginSpec(JSON.stringify({ plugin: [["@plannotator/opencode@0.28.20", { workflow: "manual" }]] }))).toBe("@plannotator/opencode@0.28.20");
    expect(openCodePluginSpec(JSON.stringify({ plugin: ["other", ["another", {}]] }))).toBeNull();
    expect(openCodePluginSpec("// c\n{ \"plugins\": [\"@plannotator/opencode@0.28.20\"] }")).toBe("@plannotator/opencode@0.28.20");
    expect(openCodePluginSpec("nope")).toBeNull();
    expect(openCodeSpecPinned("@plannotator/opencode@0.28.20")).toBe(true);
    expect(openCodeSpecPinned("@plannotator/opencode@latest")).toBe(false);
    expect(openCodeSpecPinned("@plannotator/opencode@^0.28.0")).toBe(false);
    // Opened first: in a folder the service has not opened, the update alone fails (see OPENCODE2_OPEN_FOLDER_COMMAND).
    expect(opencodePluginUpdateCommand("@plannotator/opencode@latest")).toBe("opencode2 plugin list && opencode2 plugin update @plannotator/opencode@latest");
    expect(opencodePluginUpdateCommand("@plannotator/opencode@next")).toBe("opencode2 plugin list && opencode2 plugin update @plannotator/opencode@next");
    expect(opencodePluginUpdateCommand("@plannotator/opencode")).toBe("opencode2 plugin list && opencode2 plugin update @plannotator/opencode");
    // Anything a shell would read as more than a word (a redirect, a pipe, a glob, a space) is never pasted unquoted.
    for (const unsafe of [">=0.28.0", "<0.29.0", "^0.28.0", "~0.28.0", "0.28.0 || 0.29.0", "latest; rm -rf ~", "* ", "latest x"]) {
      expect(opencodePluginUpdateCommand(`@plannotator/opencode@${unsafe}`)).toBe("opencode2 plugin list && opencode2 plugin update");
      const outdated = openCodeSessionOutdated(plugin({ version: "0.28.29", on_disk: "0.28.29" }), "0.28.31", { spec: `@plannotator/opencode@${unsafe}` })!;
      expect(outdated).toMatchObject({ update_command: "opencode2 plugin list && opencode2 plugin update", update_scope: "all" });
    }
  });

  test("OpenCode 2's config: a pin under OpenCode 1's plugin key is found; OPENCODE_CONFIG (an explicit file) comes first", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-oc-spec-")));
    try {
      const configDir = join(home, ".config", "opencode");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "opencode.json"), JSON.stringify({ plugin: [["@plannotator/opencode@0.28.29", { workflow: "manual" }]] }));
      const reader = createOpenCodeSpecReader(createAgentEnvironmentFor({ platform: process.platform, homeDir: home, env: { HOME: home, PATH: "" } }));
      const spec = reader();
      expect(spec).toBe("@plannotator/opencode@0.28.29");
      // The pin is detected, so the line says to change it (the original bug: the line never cleared).
      expect(openCodeSessionOutdated(plugin({ version: "0.28.29", on_disk: "0.28.29" }), "0.28.31", { spec })).toMatchObject({ pinned_spec: "@plannotator/opencode@0.28.29" });
      const explicit = join(home, "elsewhere.json");
      writeFileSync(explicit, JSON.stringify({ plugins: ["@plannotator/opencode@latest"] }));
      const withExplicit = createOpenCodeSpecReader(createAgentEnvironmentFor({ platform: process.platform, homeDir: home, env: { HOME: home, PATH: "", OPENCODE_CONFIG: explicit } }));
      expect(withExplicit()).toBe("@plannotator/opencode@latest");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a pinned Pi source: an exact version only", () => {
    expect(piExtensionPinned(JSON.stringify({ packages: ["npm:@plannotator/pi-extension@0.28.20"] }))).toBe(true);
    expect(piExtensionPinned(JSON.stringify({ packages: [{ source: "npm:@plannotator/pi-extension@0.28.20" }] }))).toBe(true);
    expect(piExtensionPinned(JSON.stringify({ packages: ["npm:@plannotator/pi-extension"] }))).toBe(false);
    expect(piExtensionPinned(JSON.stringify({ packages: ["npm:@plannotator/pi-extension@latest"] }))).toBe(false);
    expect(piExtensionPinned("// comment\n{ \"packages\": [\"npm:@plannotator/pi-extension@1.2.3\"] }")).toBe(true);
    expect(piExtensionPinned("not json")).toBe(false);
  });

  test("the tag refusal names the host's own command", () => {
    // Plain text (the window draws no Markdown), each host's own command.
    const fixes = [
      tagUpdateFix("pi", piSessionOutdated(plugin({ version: "0.28.30", on_disk: "0.28.31", host: "pi" }), "0.28.31")),
      tagUpdateFix("oh-my-pi", null),
      tagUpdateFix("opencode", openCodeSessionOutdated(plugin({ version: "0.28.31", on_disk: null }), "0.28.31")),
      tagUpdateFix("opencode", openCodeSessionOutdated(plugin({ version: "0.28.29", on_disk: "0.28.29" }), "0.28.31", { spec: "@plannotator/opencode@0.28.29" })),
      tagUpdateFix("claude-code", { loaded: "0.28.24", installed: "0.28.25", fix: "restart" }),
      tagUpdateFix("claude-code", { loaded: "0.28.24", installed: "0.28.25", fix: "update_plugin", update_command: "claude plugin marketplace update plannotator && claude plugin update plannotator@plannotator --scope user" }),
    ];
    for (const fix of fixes) expect(fix).not.toContain("`");
    expect(fixes[0]).toContain("/reload");
    expect(fixes[1]).toContain("omp plugin upgrade @plannotator/pi-extension");
    expect(fixes[1]).toContain("/restart");
    expect(fixes[2]).toContain("opencode2 reload");
    expect(fixes[3]).toContain("@plannotator/opencode@0.28.29");
    expect(fixes[3]).toContain("@plannotator/opencode@latest");
    expect(fixes[4]).toContain("/reload-plugins");
    // Claude Code's update stays short: the long commands live in Settings, Agents.
    expect(fixes[5]).not.toContain("claude plugin");
    expect(fixes[5]).toContain("/reload-plugins");
    expect(tagUpdateFix(null, null)).toBe("Update Plannotator there.");
  });

  test("runtimeOf: Oh My Pi polls as host pi", () => {
    expect(runtimeOf("pi", plugin({ version: "1.0.0", host: "oh-my-pi" }))).toBe("oh-my-pi");
    expect(runtimeOf("pi", null)).toBe("pi");
    expect(runtimeOf("opencode", null)).toBe("opencode");
    expect(runtimeOf("codex", null)).toBeNull();
  });
});

// ── Over a real Inbox ──

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
const wakes: InboxWake[] = [];

afterEach(async () => {
  for (const wake of wakes.splice(0)) wake.dispose();
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function world(options: { inboxVersion: string; piSettings?: unknown }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-reload-")));
  roots.push(root);
  const home = join(root, "home");
  const project = join(home, "code", "billing-api");
  mkdirSync(project, { recursive: true });
  const piDir = join(home, ".pi", "agent");
  mkdirSync(piDir, { recursive: true });
  if (options.piSettings) writeFileSync(join(piDir, "settings.json"), JSON.stringify(options.piSettings));
  const agentEnvironment = createAgentEnvironmentFor({ platform: process.platform, homeDir: home, env: { HOME: home, PATH: "" } });
  const dataDir = join(root, "data");
  const server = await startInboxServer({
    dataDir,
    version: options.inboxVersion,
    binaryPath: null,
    agentEnvironment,
    updates: { fetchRelease: async () => ({ ok: false, error: "offline in tests" }), isManaged: () => false, listSessions: () => [] },
  });
  servers.push(server);
  const client = new Client({ name: "inbox-reload-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client, project, dataDir };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;

async function poll(server: InboxServer, host: string, session: string, body: Record<string, unknown>) {
  const response = await fetch(`${base(server)}${INBOX_BRIDGE_POLL_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ session, host, waitMs: 0, ...body }),
  });
  expect(response.status).toBe(200);
}

async function asked(client: Client, project: string, session: string, host: string) {
  const result = await client.callTool({
    name: "send_message",
    arguments: { body: "Shipped it. Anything else?", project_path: project, agent_session: session, agent_host: host },
    _meta: { [INBOX_WAKES_META_KEY]: true },
  });
  return result.structuredContent as { message_id: string; thread_id: string };
}

const agents = async (server: InboxServer) => (await (await fetch(`${base(server)}/api/inbox/agents`)).json()) as InboxAgentsModel;
const list = async (server: InboxServer) =>
  (await (await fetch(`${base(server)}/api/inbox/threads?archived=exclude`)).json()) as { restart_claude_code?: number; restart_agents?: { total: number; runtimes: Record<string, number> } };

describe("over a real Inbox", () => {
  test("Pi: the package updated under the session → /reload; the session reloads → the line clears and the new version is reported", async () => {
    const { server, client, project } = await world({ inboxVersion: "0.28.31" });
    const thread = await asked(client, project, "pi-1", "pi");
    await poll(server, "pi", "pi-1", { project_path: project, busy: true, plugin: { version: "0.28.30", on_disk: "0.28.31", host: "pi" } });
    const conn = (await (await fetch(`${base(server)}/api/inbox/threads/${thread.thread_id}/sessions?asker=pi-1`)).json()) as {
      asker: { connection: { outdated: InboxSessionOutdated | null } };
    };
    expect(conn.asker.connection.outdated).toMatchObject({ fix: "reload", runtime: "pi", reload_command: "/reload", installed: "0.28.31" });
    const pi = (await agents(server)).sessions?.pi;
    expect(pi).toMatchObject({ running: 1, outdated: 1 });
    expect(pi!.sessions[0]).toMatchObject({ plugin: "0.28.30", runtime: "pi", outdated: { fix: "reload" } });
    expect((await list(server)).restart_agents).toEqual({ total: 1, runtimes: { pi: 1 } });
    // /reload: the same session now loaded what is on disk.
    await poll(server, "pi", "pi-1", { project_path: project, busy: false, plugin: { version: "0.28.31", on_disk: "0.28.31", host: "pi" } });
    expect((await agents(server)).sessions?.pi?.sessions[0]).toMatchObject({ plugin: "0.28.31", outdated: null });
    expect((await list(server)).restart_agents).toEqual({ total: 0, runtimes: {} });
  });

  test("Pi pinned in its settings: the update command is pi install, not pi update", async () => {
    const { server, project } = await world({ inboxVersion: "0.28.31", piSettings: { packages: ["npm:@plannotator/pi-extension@0.28.29"] } });
    await poll(server, "pi", "pi-pin", { project_path: project, plugin: { version: "0.28.29", on_disk: "0.28.29", host: "pi" } });
    expect((await agents(server)).sessions?.pi?.sessions[0]?.outdated).toMatchObject({ fix: "update_extension", update_command: "pi install npm:@plannotator/pi-extension" });
    // An update fix is not counted in the sidebar (as Claude Code's update_plugin).
    expect((await list(server)).restart_agents?.total).toBe(0);
  });

  test("Oh My Pi (polls as pi, says host oh-my-pi) → /restart; the sidebar names it", async () => {
    const { server, project } = await world({ inboxVersion: "dev" });
    await poll(server, "pi", "omp-1", { project_path: project, plugin: { version: "0.28.30", on_disk: "0.28.31", host: "oh-my-pi" } });
    expect((await agents(server)).sessions?.pi?.sessions[0]).toMatchObject({ runtime: "oh-my-pi", outdated: { reload_command: "/restart", runtime: "oh-my-pi" } });
    expect((await list(server)).restart_agents).toEqual({ total: 1, runtimes: { "oh-my-pi": 1 } });
  });

  test("the shared InboxWake sends what its host reports, so the Inbox judges it", async () => {
    const { server, project, dataDir } = await world({ inboxVersion: "dev" });
    const connection = new InboxAgentConnection({ dataDir, host: "pi", agentName: "Pi", tools: [] });
    let onDisk: string | null = "0.28.30";
    const wake = new InboxWake(connection, "pi-wake", {
      isBusy: () => false,
      deliver: async () => {},
      notify: () => {},
      projectPath: () => project,
      plugin: () => ({ version: "0.28.30", on_disk: onDisk, host: "pi" }),
    }, 100);
    wakes.push(wake);
    wake.start();
    const listed = async () => (await agents(server)).sessions?.pi?.sessions.find((s) => s.session === "pi-wake") ?? null;
    const deadline = Date.now() + 10_000;
    while (!(await listed()) && Date.now() < deadline) await Bun.sleep(100);
    expect(await listed()).toMatchObject({ plugin: "0.28.30", outdated: null });
    // The package is updated under it: the next poll says so.
    onDisk = "0.28.31";
    wake.dispose();
    const again = new InboxWake(connection, "pi-wake", {
      isBusy: () => false,
      deliver: async () => {},
      notify: () => {},
      projectPath: () => project,
      plugin: () => ({ version: "0.28.30", on_disk: onDisk, host: "pi" }),
    }, 100);
    wakes.push(again);
    again.start();
    const deadline2 = Date.now() + 10_000;
    while ((await listed())?.outdated?.fix !== "reload" && Date.now() < deadline2) await Bun.sleep(100);
    expect((await listed())?.outdated).toMatchObject({ fix: "reload", reload_command: "/reload" });
  });

  test("tag_needs_update names the host's command", async () => {
    const { server, client, project } = await world({ inboxVersion: "dev" });
    const thread = await asked(client, project, "cc-owner", "claude-code");
    // A live Pi session whose connection predates tags (no `tags: true`), whose package changed under it.
    await poll(server, "pi", "pi-old", { project_path: project, plugin: { version: "0.28.24", on_disk: "0.28.31", host: "pi" } });
    const response = await fetch(`${base(server)}/api/inbox/messages/${thread.message_id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotency_key: "tag-1", words: "@Pi look at this", tags: [{ host: "pi", session: "pi-old" }] }),
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string; error: string };
    expect(body.code).toBe("tag_needs_update");
    expect(body.error).toContain("/reload");
    expect(body.error).not.toContain("`");
  });
});
