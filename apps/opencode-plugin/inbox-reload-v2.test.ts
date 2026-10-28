/**
 * The reload line for OpenCode 2 (owner approval "reload-hosts"), proved on
 * the REAL OpenCode 2: its background service (`opencode2 service start`,
 * as people run it) under a scratch HOME and XDG dirs, with this plugin
 * installed from its packed tarball through a throwaway registry that serves
 * two repacked versions, against a real Inbox (started in this process at
 * 0.28.99, its release check stubbed: it never reaches GitHub). The model is
 * a scripted OpenAI-compatible endpoint (tests/helpers/scripted-model.ts).
 * No mocks.
 *
 * What is proved, each with the time it took:
 *  1. The plugin on disk equal to what the session loaded and behind this
 *     Inbox: Settings → Agents says `opencode2 plugin update
 *     @plannotator/opencode@latest` (the spec exactly as the config file has
 *     it, which the Inbox reads); after the person runs it, the session
 *     reports the newer version and the line goes.
 *  2. The install script deleting the plugin's generation folder under the
 *     running service: the line says `opencode2 reload` within seconds;
 *     after the person runs it, the old plugin's polls stop (the setup's
 *     cleanup) and the session reports the version the reload installed.
 *  3. A config that pins an exact version: `opencode2 plugin update` changes
 *     nothing, so the Inbox says to change the pin to
 *     `@plannotator/opencode@latest`, then `opencode2 reload`; done, the
 *     session reports the newer version.
 *
 * Runs where OPENCODE2_BIN and OPENCODE_PLUGIN_TARBALL name the host and the
 * packed plugin (the "OpenCode 2 installed package" CI job); skipped
 * otherwise. INBOX_PROOF_DIR=<dir> keeps a transcript under
 * <dir>/opencode2-reload/. RELOAD_PROOF_SHOTS=<dir> adds screenshots of
 * Settings → Agents while the line shows (tests/helpers/reload-proof-shots.ts).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { InboxHostSessions } from "@plannotator/core/inbox-types";
import { createAgentEnvironmentFor } from "../../packages/server/inbox-agents";
import { startInboxServer, type InboxServer } from "../../packages/server/inbox";
import { createInboxWorld, destroyInboxWorld, waitFor, worldEnv, type InboxWorld } from "../../tests/helpers/inbox-world";
import { lastMessage, startScriptedModel, type ScriptedModel } from "../../tests/helpers/scripted-model";
import { builtInboxHtml, shootAgents } from "../../tests/helpers/reload-proof-shots";

const opencodeBin = process.env.OPENCODE2_BIN;
const tarball = process.env.OPENCODE_PLUGIN_TARBALL;
const NAME = "@plannotator/opencode";
const INBOX_VERSION = "0.28.99";
/** A cold runner installs the plugin in about 47 s (the smoke's measurement). */
const PLUGIN_TIMEOUT_MS = 300_000;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  // Each step bounded: a stop that never settles must not hold the run open (it is named on stderr).
  for (const [index, cleanup] of cleanups.splice(0).reverse().entries()) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), 30_000)));
    const result = await Promise.race([Promise.resolve().then(cleanup).then(() => "done" as const), late]);
    clearTimeout(timer);
    if (result === "late") console.error(`cleanup ${index} did not settle in 30 s: ${String(cleanup).slice(0, 120)}`);
  }
});

/** The packed plugin again, as `version` (only package.json changes): what a newer release looks like to OpenCode. */
function repack(source: string, version: string, into: string): string {
  const work = path.join(into, `pack-${version}`);
  mkdirSync(work, { recursive: true });
  const untar = Bun.spawnSync(["tar", "-xzf", source, "-C", work]);
  if (untar.exitCode !== 0) throw new Error(`tar -x: ${untar.stderr.toString()}`);
  const pkgPath = path.join(work, "package", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
  writeFileSync(pkgPath, `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
  const out = path.join(into, `plannotator-opencode-${version}.tgz`);
  const tar = Bun.spawnSync(["tar", "-czf", out, "-C", work, "package"]);
  if (tar.exitCode !== 0) throw new Error(`tar -c: ${tar.stderr.toString()}`);
  return out;
}

/** A throwaway registry: the versions published so far, `latest` the last. */
function npmRegistry() {
  const published = new Map<string, { file: string; manifest: Record<string, unknown> }>();
  let latest = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = decodeURIComponent(new URL(request.url).pathname.slice(1));
      if (pathname === NAME) {
        return Response.json({
          name: NAME,
          "dist-tags": { latest },
          versions: Object.fromEntries([...published].map(([version, entry]) => [version, { ...entry.manifest, version, dist: { tarball: `${url}/tgz/${version}` } }])),
        });
      }
      const tgz = /^tgz\/(.+)$/.exec(pathname);
      if (tgz && published.has(tgz[1]!)) return new Response(Bun.file(published.get(tgz[1]!)!.file));
      return new Response("not found", { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    publish(version: string, file: string, manifest: Record<string, unknown>) {
      published.set(version, { file, manifest });
      latest = version;
    },
    stop: () => server.stop(true),
  };
}

interface Service {
  env: Record<string, string>;
  url: string;
  run(args: string[]): { code: number; out: string };
  /** A command the person types in a terminal (OpenCode's CLI draws progress and may ask there). */
  type(args: string[], timeoutMs?: number): Promise<{ code: number; out: string; ms: number }>;
  api<T = unknown>(method: string, route: string, body?: unknown): Promise<T>;
}

/** `opencode2 service start` in the world's scratch HOME and XDG dirs (a detached process, never launchd), with the scripted model as its provider. */
/** The scratch XDG dirs of a world (the service's and, for its config, the Inbox's). */
const xdgOf = (w: InboxWorld) => path.join(w.root, "xdg");
const configFileOf = (w: InboxWorld) => path.join(xdgOf(w), "config", "opencode", "opencode.json");

/** OpenCode 2's global config file, as a person writes it: the plugin's spec and the scripted model. */
function writeConfig(w: InboxWorld, m: ScriptedModel, spec: string, key: "plugins" | "plugin" = "plugins"): void {
  mkdirSync(path.dirname(configFileOf(w)), { recursive: true });
  writeFileSync(
    configFileOf(w),
    `${JSON.stringify(
      {
        // OpenCode 2's `plugins`, or OpenCode 1's `plugin` with a [spec, options] pair (what our installer writes; OpenCode 2 reads it too).
        [key]: [key === "plugins" ? { package: spec, options: { workflow: "manual" } } : [spec, { workflow: "manual" }]],
        providers: {
          scripted: {
            package: "@opencode/ai/providers/openai-compatible",
            settings: { apiKey: "scripted", baseURL: m.baseUrl },
            models: { scripted: { name: "Scripted" } },
          },
        },
        model: "scripted/scripted",
      },
      null,
      2,
    )}\n`,
  );
}

async function startService(w: InboxWorld, m: ScriptedModel, registryUrl: string, spec = `${NAME}@latest`, key: "plugins" | "plugin" = "plugins"): Promise<Service> {
  const xdg = xdgOf(w);
  for (const dir of ["config", "data", "cache", "state"]) mkdirSync(path.join(xdg, dir), { recursive: true });
  writeConfig(w, m, spec, key);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...worldEnv(w),
    XDG_CONFIG_HOME: path.join(xdg, "config"),
    XDG_DATA_HOME: path.join(xdg, "data"),
    XDG_CACHE_HOME: path.join(xdg, "cache"),
    XDG_STATE_HOME: path.join(xdg, "state"),
    OPENCODE_DB: path.join(xdg, "opencode.db"),
    NPM_CONFIG_REGISTRY: registryUrl,
    npm_config_registry: registryUrl,
  };
  delete env.OPENCODE_CONFIG_CONTENT;
  delete env.OPENCODE_CONFIG_DIR;
  delete env.OPENCODE_CONFIG;
  const run = (args: string[]) => {
    const result = Bun.spawnSync([opencodeBin!, ...args], { cwd: w.project, env, stdout: "pipe", stderr: "pipe", timeout: 180_000 });
    return { code: result.exitCode ?? -1, out: `${result.stdout.toString()}${result.stderr.toString()}`.trim() };
  };
  // The person's shell: `opencode2` on PATH, in whatever folder they paste a copied command.
  const shellBin = path.join(w.root, "shell-bin");
  mkdirSync(shellBin, { recursive: true });
  symlinkSync(opencodeBin!, path.join(shellBin, "opencode2"));
  const inTerminal = async (argv: string[], cwd: string, timeoutMs: number) => {
    let screen = "";
    const t0 = Date.now();
    const proc = Bun.spawn(argv, {
      cwd,
      env: { ...env, PATH: `${shellBin}${path.delimiter}${env.PATH ?? ""}` },
      terminal: { cols: 120, rows: 40, data: (_t, data) => void (screen += new TextDecoder().decode(data)) },
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    await proc.exited;
    clearTimeout(timer);
    const out = screen.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\r/g, "").trim();
    return { code: proc.exitCode ?? -1, out, ms: Date.now() - t0 };
  };
  const type = (args: string[], timeoutMs = 180_000) => inTerminal([opencodeBin!, ...args], w.project, timeoutMs);
  /** A command the Inbox offers to copy, pasted as it is into bash in `cwd`. */
  const paste = (command: string, cwd: string, timeoutMs = 180_000) => inTerminal(["bash", "-c", command], cwd, timeoutMs);
  const started = run(["service", "start"]);
  if (started.code !== 0) throw new Error(`service start: ${started.out}`);
  cleanups.push(() => void run(["service", "stop"]));
  const url = /https?:\/\/[^\s]+/.exec(run(["service", "status"]).out)?.[0]?.replace(/\/$/, "");
  if (!url) throw new Error("no service URL");
  const password = (JSON.parse(readFileSync(path.join(xdg, "config", "opencode", "service.json"), "utf8")) as { password: string }).password;
  const auth = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
  const directory = encodeURIComponent(w.project);
  const api = async <T,>(method: string, route: string, body?: unknown): Promise<T> => {
    // No pooled connection: a later test's service can take the same port, and a socket kept from the stopped one hangs.
    const response = await fetch(`${url}${route}`, {
      keepalive: false,
      signal: AbortSignal.timeout(60_000),
      method,
      headers: { ...auth, "x-opencode-directory": directory, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${route} answered ${response.status}: ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  };
  await waitFor("OpenCode 2 to answer", async () => (await fetch(`${url}/api/info`, { headers: auth, keepalive: false, signal: AbortSignal.timeout(5_000) }).catch(() => null))?.ok, 120_000);
  await waitFor(
    "the plugin to activate",
    async () => {
      const listed = await api<{ data?: ({ id?: string; status?: string; error?: string } | string)[] }>("GET", "/api/plugin").catch(() => null);
      const entry = listed?.data?.find((plugin) => (typeof plugin === "string" ? plugin === "plannotator" : plugin.id === "plannotator"));
      if (entry && typeof entry !== "string" && entry.status === "failed") throw new Error(`plugin failed: ${entry.error}`);
      return !!entry;
    },
    PLUGIN_TIMEOUT_MS,
  );
  return { env, url, run, type, paste, api };
}

/** The Inbox at 0.28.99 in this process: the world's data dir, its release check stubbed (never GitHub), OpenCode's config the scratch one. */
async function inboxAt(w: InboxWorld): Promise<InboxServer> {
  mkdirSync(w.dataDir, { recursive: true });
  writeFileSync(path.join(w.dataDir, "config.json"), JSON.stringify({ inboxTool: { opencode: true } }));
  const server = await startInboxServer({
    dataDir: w.dataDir,
    version: INBOX_VERSION,
    binaryPath: null,
    ...builtInboxHtml(),
    agentEnvironment: createAgentEnvironmentFor({ platform: process.platform, homeDir: w.home, env: { HOME: w.home, PATH: "", XDG_CONFIG_HOME: path.join(xdgOf(w), "config") } }),
    updates: { fetchRelease: async () => ({ ok: false as const, error: "offline in tests" }), isManaged: () => false, listSessions: () => [] },
  });
  cleanups.push(() => server.stop());
  return server;
}

async function openCodeSessions(server: InboxServer): Promise<InboxHostSessions | null> {
  const model = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/agents`)).json()) as { sessions?: { opencode?: InboxHostSessions } };
  return model.sessions?.opencode ?? null;
}

async function sessionRow(server: InboxServer, session: string) {
  return (await openCodeSessions(server))?.sessions.find((s) => s.session === session) ?? null;
}

describe.skipIf(!opencodeBin || !tarball)("OpenCode 2: the reload line, on the real OpenCode 2 service", () => {
  test("behind this Inbox: opencode2 plugin update <the configured spec>; generation deleted: opencode2 reload; each clears once run", async () => {
    const w = createInboxWorld("plannotator-oc2-reload-", "01-plugin-update-and-reload", "opencode2-reload");
    cleanups.push(() => destroyInboxWorld(w));
    const packs = realpathSync(mkdtempSync(path.join(tmpdir(), "plannotator-oc2-packs-")));
    cleanups.push(() => rmSync(packs, { recursive: true, force: true }));
    const manifest = JSON.parse(readFileSync(path.join(import.meta.dir, "package.json"), "utf8")) as Record<string, unknown>;
    const registry = npmRegistry();
    cleanups.push(() => registry.stop());
    registry.publish("0.28.98", repack(tarball!, "0.28.98", packs), manifest);

    const server = await inboxAt(w);
    const m = startScriptedModel((request) => {
      if (request.tools.length === 0) return { text: "Ledger export" };
      const last = lastMessage(request);
      if (last.role === "tool") return { text: "Sent." };
      if (last.text.includes("Ask the person")) return { toolCall: { name: "plannotator_inbox", arguments: { action: "send_message", body: "Nightly or hourly for the ledger export?" } } };
      return { text: "OK." };
    });
    cleanups.push(() => m.stop());
    const service = await startService(w, m, registry.url);
    w.proof(`OpenCode 2 service ${service.url} (${service.run(["--version"]).out}); Inbox ${INBOX_VERSION} on port ${server.port}; plugin 0.28.98 published`);

    const session = (await service.api<{ data: { id: string } }>("POST", "/api/session", {})).data.id;
    await service.api("POST", `/api/session/${session}/prompt`, { text: "Ask the person about the export." });
    const first = await waitFor("the session to poll with its plugin", async () => (await sessionRow(server, session))?.outdated ?? null, 120_000);
    expect(first.loaded).toBe("0.28.98");
    expect(first.installed).toBe(INBOX_VERSION);
    expect(first.fix).toBe("update_extension");
    expect(first.update_command).toBe(`opencode2 plugin list && opencode2 plugin update ${NAME}@latest`);
    w.proof(`1. plugin 0.28.98 loaded and on disk, Inbox ${INBOX_VERSION}: outdated ${JSON.stringify(first)}`);
    await shootAgents(server.port, "real-opencode2-plugin-update", { sidebar: false });

    // A newer release; the person pastes the command the Inbox showed, in a folder OpenCode never opened
    // (the update alone fails there: "Plugin is not configured").
    registry.publish("0.28.99", repack(tarball!, "0.28.99", packs), manifest);
    const elsewhere = path.join(w.root, "a-folder-opencode-never-opened");
    mkdirSync(elsewhere, { recursive: true });
    let t0 = Date.now();
    const updated = await service.paste(first.update_command!, elsewhere, 120_000);
    w.proof(`   $ ${first.update_command}  (exit ${updated.code}, ${updated.ms} ms)\n${updated.out.replace(/^/gm, "     ")}`);
    expect(updated.code).toBe(0);
    expect(updated.out).toContain('Updated Server plugin "plannotator"');
    // The new generation polls once the session runs again (its wakes start with the session's next turn or tool call).
    await service.api("POST", `/api/session/${session}/prompt`, { text: "Ask the person about the export." });
    const after = await waitFor("the session to report 0.28.99", async () => {
      const row = await sessionRow(server, session);
      return row?.plugin === "0.28.99" ? row : null;
    }, 120_000);
    expect(after.outdated).toBeNull();
    w.proof(`   reported 0.28.99, no line: ${Date.now() - t0} ms after the command`);
    // The old generation's polls stopped (its cleanup aborted them): it never reports 0.28.98 again.
    for (let i = 0; i < 10; i++) {
      await Bun.sleep(500);
      expect((await sessionRow(server, session))?.plugin).toBe("0.28.99");
    }
    w.proof("   5 s later still 0.28.99 on every read: the old plugin's polls stopped");

    // 2. The install script deletes the plugin's generation folder under the running service.
    const cache = path.join(service.env.XDG_CACHE_HOME!, "opencode", "npm", "@plannotator");
    rmSync(cache, { recursive: true, force: true });
    t0 = Date.now();
    const gone = await waitFor("the line for the deleted generation", async () => {
      const outdated = (await sessionRow(server, session))?.outdated;
      return outdated?.reload_command === "opencode2 reload" ? outdated : null;
    }, 30_000);
    expect(gone.installed).toBeNull();
    expect(gone.fallback_command).toBe("opencode2 service restart");
    w.proof(`2. deleted ${cache}: the Inbox said ${JSON.stringify(gone)} after ${Date.now() - t0} ms`);
    const agents = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads?archived=exclude`)).json()) as { restart_agents?: unknown };
    w.proof(`   list restart_agents: ${JSON.stringify(agents.restart_agents ?? null)}`);
    await shootAgents(server.port, "real-opencode2-generation-deleted");

    registry.publish("0.29.0", repack(tarball!, "0.29.0", packs), manifest);
    t0 = Date.now();
    const reloaded = await service.type(["reload"], 120_000);
    w.proof(`   $ opencode2 reload  (exit ${reloaded.code}, ${reloaded.ms} ms)\n${reloaded.out.replace(/^/gm, "     ")}`);
    expect(reloaded.code).toBe(0);
    await waitFor("the plugin to come back", async () => {
      const listed = await service.api<{ data?: ({ id?: string; status?: string } | string)[] }>("GET", "/api/plugin").catch(() => null);
      return listed?.data?.some((p) => (typeof p === "string" ? p === "plannotator" : p.id === "plannotator" && p.status !== "failed"));
    }, PLUGIN_TIMEOUT_MS);
    await service.api("POST", `/api/session/${session}/prompt`, { text: "Ask the person about the export." });
    const back = await waitFor("the session to report 0.29.0", async () => {
      const row = await sessionRow(server, session);
      return row?.plugin === "0.29.0" ? row : null;
    }, 180_000);
    expect(back.outdated).toBeNull();
    w.proof(`   reported 0.29.0, no line: ${Date.now() - t0} ms after the command`);
  }, 900_000);

  test("a pinned exact version: plugin update changes nothing; the Inbox says to change the pin, then opencode2 reload", async () => {
    const w = createInboxWorld("plannotator-oc2-reload-", "02-pinned", "opencode2-reload");
    cleanups.push(() => destroyInboxWorld(w));
    const packs = realpathSync(mkdtempSync(path.join(tmpdir(), "plannotator-oc2-packs-")));
    cleanups.push(() => rmSync(packs, { recursive: true, force: true }));
    const manifest = JSON.parse(readFileSync(path.join(import.meta.dir, "package.json"), "utf8")) as Record<string, unknown>;
    const registry = npmRegistry();
    cleanups.push(() => registry.stop());
    registry.publish("0.28.98", repack(tarball!, "0.28.98", packs), manifest);
    registry.publish("0.28.99", repack(tarball!, "0.28.99", packs), manifest);

    const server = await inboxAt(w);
    const m = startScriptedModel((request) => {
      if (request.tools.length === 0) return { text: "Ledger export" };
      const last = lastMessage(request);
      if (last.role === "tool") return { text: "Sent." };
      if (last.text.includes("Ask the person")) return { toolCall: { name: "plannotator_inbox", arguments: { action: "send_message", body: "Nightly or hourly for the ledger export?" } } };
      return { text: "OK." };
    });
    cleanups.push(() => m.stop());
    const pinned = `${NAME}@0.28.98`;
    // The pin as our installer writes it: OpenCode 1's `plugin` key with a [spec, options] pair.
    const service = await startService(w, m, registry.url, pinned, "plugin");
    w.proof(`OpenCode 2 service ${service.url}; Inbox ${INBOX_VERSION}; the config pins ${pinned} under "plugin" as [spec, options]; 0.28.99 is latest`);

    const session = (await service.api<{ data: { id: string } }>("POST", "/api/session", {})).data.id;
    await service.api("POST", `/api/session/${session}/prompt`, { text: "Ask the person about the export." });
    const line = await waitFor("the session to poll with its plugin", async () => (await sessionRow(server, session))?.outdated ?? null, 120_000);
    expect(line.loaded).toBe("0.28.98");
    expect(line.fix).toBe("update_extension");
    expect(line.pinned_spec).toBe(pinned);
    expect(line.pin_to).toBe(`${NAME}@latest`);
    expect(line.reload_command).toBe("opencode2 reload");
    expect(line.update_command).toBeUndefined();
    w.proof(`1. pinned: outdated ${JSON.stringify(line)}`);
    // An update or a pin is not a reload: the sidebar's "Reload" row does not count it.
    const list = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads?archived=exclude`)).json()) as { restart_agents?: { runtimes: Record<string, number> } };
    expect(list.restart_agents?.runtimes.opencode ?? 0).toBe(0);
    await shootAgents(server.port, "real-opencode2-pinned", { sidebar: false });

    // What the Inbox does not say, proved: plugin update leaves a pin where it is.
    const noop = await service.type(["plugin", "update"], 120_000);
    w.proof(`   $ opencode2 plugin update  (exit ${noop.code}, ${noop.ms} ms)\n${noop.out.replace(/^/gm, "     ")}`);
    expect(noop.out).toMatch(/no plugin updates/i);

    // What it says: change the pin, then reload.
    writeConfig(w, m, line.pin_to!, "plugin");
    const t0 = Date.now();
    const reloaded = await service.type(["reload"], 120_000);
    w.proof(`   changed the pin to ${line.pin_to}; $ opencode2 reload  (exit ${reloaded.code}, ${reloaded.ms} ms)\n${reloaded.out.replace(/^/gm, "     ")}`);
    expect(reloaded.code).toBe(0);
    await waitFor("the plugin to come back", async () => {
      const listed = await service.api<{ data?: ({ id?: string; status?: string } | string)[] }>("GET", "/api/plugin").catch(() => null);
      return listed?.data?.some((p) => (typeof p === "string" ? p === "plannotator" : p.id === "plannotator" && p.status !== "failed"));
    }, PLUGIN_TIMEOUT_MS);
    await service.api("POST", `/api/session/${session}/prompt`, { text: "Ask the person about the export." });
    const back = await waitFor("the session to report 0.28.99", async () => {
      const row = await sessionRow(server, session);
      return row?.plugin === "0.28.99" ? row : null;
    }, 180_000);
    expect(back.outdated).toBeNull();
    w.proof(`   reported 0.28.99, no line: ${Date.now() - t0} ms after the reload`);
  }, 900_000);
});
