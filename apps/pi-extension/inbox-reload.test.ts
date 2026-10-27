/**
 * The reload line for Pi and Oh My Pi (owner approval "reload-hosts"),
 * proved on the REAL hosts in their interactive mode, in a pseudo-terminal,
 * the way a person types `/reload` or `/restart`: the extension installed as
 * people install it (`pi install npm:@plannotator/pi-extension`,
 * `omp plugin install @plannotator/pi-extension`) from the packed tarball
 * through a throwaway registry (its dependencies proxied from npm), under a
 * scratch HOME and agent dir, against a real Inbox started in this process at
 * 0.28.99 (its release check stubbed: it never reaches GitHub). The model is
 * a scripted OpenAI-compatible endpoint (tests/helpers/scripted-model.ts).
 *
 * What is proved, each with the time it took:
 *  - Pi: the extension on disk equal to what the session loaded and behind
 *    this Inbox: `pi update --extensions`, then `/reload`. The person updates:
 *    within seconds the Inbox says `/reload` alone, and the session says the
 *    package changed under it; `/reload` typed in the session: the session
 *    reports the new version and the line goes.
 *  - Oh My Pi (PLANNOTATOR_OMP_BIN): the same with
 *    `omp plugin upgrade @plannotator/pi-extension` and `/restart`.
 *
 * Opt-in (it installs the extension's dependencies from npm):
 * PLANNOTATOR_RELOAD_PROOF=1 and PI_EXTENSION_TARBALL=<npm pack of this
 * package>. INBOX_PROOF_DIR=<dir> keeps a transcript (and the terminal's
 * text) under <dir>/pi-reload/. RELOAD_PROOF_SHOTS=<dir> adds screenshots of
 * Settings → Agents while the line shows (tests/helpers/reload-proof-shots.ts).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxHostSessions, InboxOpenSession } from "../../packages/core/inbox-types.ts";
import { createAgentEnvironmentFor } from "../../packages/server/inbox-agents.ts";
import { startInboxServer, type InboxServer } from "../../packages/server/inbox.ts";
import { createInboxWorld, destroyInboxWorld, waitFor, worldEnv, type InboxWorld } from "../../tests/helpers/inbox-world.ts";
import { lastMessage, startScriptedModel, type ScriptedModel } from "../../tests/helpers/scripted-model.ts";
import { builtInboxHtml, shootAgents } from "../../tests/helpers/reload-proof-shots.ts";

const proofOn = process.env.PLANNOTATOR_RELOAD_PROOF === "1" && !!process.env.PI_EXTENSION_TARBALL && process.platform !== "win32";
const tarball = process.env.PI_EXTENSION_TARBALL ?? "";
const ompBin = process.env.PLANNOTATOR_OMP_BIN;
const NAME = "@plannotator/pi-extension";
const INBOX_VERSION = "0.28.99";
const piCli = join(import.meta.dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function repack(source: string, version: string, into: string): string {
	const work = join(into, `pack-${version}`);
	mkdirSync(work, { recursive: true });
	const untar = Bun.spawnSync(["tar", "-xzf", source, "-C", work]);
	if (untar.exitCode !== 0) throw new Error(`tar -x: ${untar.stderr.toString()}`);
	const pkgPath = join(work, "package", "package.json");
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
	writeFileSync(pkgPath, `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
	const out = join(into, `plannotator-pi-extension-${version}.tgz`);
	const tar = Bun.spawnSync(["tar", "-czf", out, "-C", work, "package"]);
	if (tar.exitCode !== 0) throw new Error(`tar -c: ${tar.stderr.toString()}`);
	return out;
}

/** A throwaway registry: this package's versions published so far; every other package proxied from npm. */
function npmRegistry() {
	const published = new Map<string, { file: string; manifest: Record<string, unknown> }>();
	let latest = "";
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(request) {
			const requestUrl = new URL(request.url);
			const pathname = decodeURIComponent(requestUrl.pathname.slice(1));
			if (pathname === NAME) {
				return Response.json({
					name: NAME,
					"dist-tags": { latest },
					versions: Object.fromEntries([...published].map(([version, entry]) => [version, { ...entry.manifest, version, dist: { tarball: `${url}/tgz/${version}` } }])),
				});
			}
			const tgz = /^tgz\/(.+)$/.exec(pathname);
			if (tgz && published.has(tgz[1]!)) return new Response(Bun.file(published.get(tgz[1]!)!.file));
			const upstream = await fetch(`https://registry.npmjs.org${requestUrl.pathname}${requestUrl.search}`);
			const headers = new Headers(upstream.headers);
			headers.delete("content-encoding");
			headers.delete("content-length");
			return new Response(upstream.body, { status: upstream.status, headers });
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

async function inboxAt(w: InboxWorld): Promise<InboxServer> {
	mkdirSync(w.dataDir, { recursive: true });
	writeFileSync(join(w.dataDir, "config.json"), JSON.stringify({ inboxTool: { pi: true } }));
	const server = await startInboxServer({
		dataDir: w.dataDir,
		version: INBOX_VERSION,
		binaryPath: null,
		...builtInboxHtml(),
		agentEnvironment: createAgentEnvironmentFor({ platform: process.platform, homeDir: w.home, env: { HOME: w.home, PATH: "" } }),
		updates: { fetchRelease: async () => ({ ok: false as const, error: "offline in tests" }), isManaged: () => false, listSessions: () => [] },
	});
	cleanups.push(() => server.stop());
	return server;
}

async function piSessions(server: InboxServer): Promise<InboxOpenSession[]> {
	const model = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/agents`)).json()) as { sessions?: { pi?: InboxHostSessions } };
	return model.sessions?.pi?.sessions ?? [];
}

/** The only live Pi session the Inbox sees (each proof runs one session until its restart). */
async function onlySession(server: InboxServer): Promise<InboxOpenSession | null> {
	const sessions = await piSessions(server);
	return sessions.length === 1 ? sessions[0]! : null;
}

const strip = (text: string) =>
	text
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[()][A-Za-z0-9]/g, "")
		.replace(/\x1b[=>78DEHM]/g, "");

/** A host in a pseudo-terminal, as a person runs it. */
function terminal(command: string[], cwd: string, env: Record<string, string>) {
	let screen = "";
	const proc = Bun.spawn(command, {
		cwd,
		env,
		terminal: {
			cols: 140,
			rows: 45,
			data(_term, data) {
				screen += new TextDecoder().decode(data);
			},
		},
	});
	const write = (text: string) => proc.terminal!.write(text);
	return {
		text: () => strip(screen),
		mark: () => strip(screen).length,
		since: (mark: number) => strip(screen).slice(mark),
		/** Raw keys (Escape, Enter), one at a time. */
		async keys(keys: string[]) {
			for (const key of keys) {
				write(key);
				await Bun.sleep(1_000);
			}
		},
		async type(text: string) {
			for (const ch of text) {
				write(ch);
				await Bun.sleep(8);
			}
			await Bun.sleep(150);
			write("\r");
		},
		async stop() {
			proc.kill();
			await Promise.race([proc.exited, Bun.sleep(5_000)]);
			if (proc.exitCode === null) proc.kill("SIGKILL");
		},
	};
}

function scriptedModel(): ScriptedModel {
	return startScriptedModel((request) => {
		if (request.tools.length === 0) return { text: "Ledger export" };
		const last = lastMessage(request);
		if (last.role === "tool") return { text: "Sent." };
		if (last.text.includes("Ask the person")) return { toolCall: { name: "plannotator_inbox", arguments: { action: "send_message", body: "Nightly or hourly for the ledger export?" } } };
		return { text: "OK." };
	});
}

interface HostCase {
	name: string;
	/** The world, the registry and the model are ready: install the extension, return the host's command line. */
	setup(w: InboxWorld, env: Record<string, string>, m: ScriptedModel): { command: string[]; install: string[]; update: string[] };
	updateCommand: string;
	reload: string;
	host: "pi" | "oh-my-pi";
	/** Keys before the first prompt: Oh My Pi's first run opens its setup (Enter skips the splash, Escape the steps). */
	prelude?: string[];
}

const PI: HostCase = {
	name: "pi",
	host: "pi",
	updateCommand: "pi update --extensions",
	reload: "/reload",
	setup(w, env, m) {
		const agentDir = env.PI_CODING_AGENT_DIR!;
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					scripted: {
						baseUrl: m.baseUrl,
						api: "openai-completions",
						apiKey: "scripted",
						compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
						models: [{ id: "scripted", name: "Scripted", reasoning: false, contextWindow: 200_000, maxTokens: 8_192 }],
					},
				},
			}),
		);
		return {
			install: ["node", piCli, "install", `npm:${NAME}`],
			update: ["node", piCli, "update", "--extensions"],
			command: ["node", piCli, "--provider", "scripted", "--model", "scripted", "--no-skills"],
		};
	},
};

const OMP: HostCase = {
	name: "oh-my-pi",
	host: "oh-my-pi",
	updateCommand: `omp plugin upgrade ${NAME}`,
	reload: "/restart",
	prelude: ["\r", "\x1b", "\x1b", "\x1b", "\x1b"],
	setup(w, env, m) {
		const agentDir = env.PI_CODING_AGENT_DIR!;
		writeFileSync(
			join(agentDir, "models.yml"),
			[
				"providers:",
				"  scripted:",
				`    baseUrl: ${m.baseUrl}`,
				"    apiKey: scripted-key",
				"    api: openai-completions",
				"    models:",
				"      - id: scripted",
				"        name: Scripted",
				"        reasoning: false",
				"        input: [text]",
				"        contextWindow: 200000",
				"        maxTokens: 8192",
				"",
			].join("\n"),
		);
		return {
			install: [ompBin!, "plugin", "install", NAME],
			update: [ompBin!, "plugin", "upgrade", NAME],
			command: [ompBin!, "--model", "scripted/scripted", "--no-skills", "--no-rules", "--no-title", "--no-lsp"],
		};
	},
};

async function prove(c: HostCase): Promise<void> {
	const w = createInboxWorld(`plannotator-${c.name}-reload-`, `${c.name}-update-then-${c.reload.slice(1)}`, "pi-reload");
	cleanups.push(() => destroyInboxWorld(w));
	const packs = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-pi-packs-")));
	cleanups.push(() => rmSync(packs, { recursive: true, force: true }));
	const manifest = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8")) as Record<string, unknown>;
	const registry = npmRegistry();
	cleanups.push(() => registry.stop());
	registry.publish("0.28.98", repack(tarball, "0.28.98", packs), manifest);
	const server = await inboxAt(w);
	const m = scriptedModel();
	cleanups.push(() => m.stop());

	const agentDir = join(w.home, c.host === "oh-my-pi" ? ".omp" : ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		...worldEnv(w),
		PI_CODING_AGENT_DIR: agentDir,
		XDG_CONFIG_HOME: join(w.home, ".config"),
		XDG_CACHE_HOME: join(w.home, ".cache"),
		XDG_DATA_HOME: join(w.home, ".local", "share"),
		XDG_STATE_HOME: join(w.home, ".local", "state"),
		NPM_CONFIG_REGISTRY: registry.url,
		npm_config_registry: registry.url,
		BUN_CONFIG_REGISTRY: registry.url,
		npm_config_cache: join(w.root, "npm-cache"),
		BUN_INSTALL_CACHE_DIR: join(w.root, "bun-cache"),
		PLANNOTATOR_GLIMPSE: "0",
		TERM: "xterm-256color",
	};
	const { command, install, update } = c.setup(w, env, m);
	// Async: the registry answers from this process, so a synchronous spawn would wait on itself.
	const run = async (args: string[]) => {
		const t0 = Date.now();
		const proc = Bun.spawn(args, { cwd: w.project, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const timer = setTimeout(() => proc.kill(), 300_000);
		const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		await proc.exited;
		clearTimeout(timer);
		return { code: proc.exitCode ?? -1, ms: Date.now() - t0, out: `${out}${err}`.trim() };
	};
	const installed = await run(install);
	w.proof(`$ ${install.slice(c.host === "pi" ? 2 : 1).join(" ")}  (exit ${installed.code}, ${installed.ms} ms)\n${installed.out.replace(/^/gm, "  ")}`);
	expect(installed.code).toBe(0);

	const term = terminal(command, w.project, env);
	cleanups.push(() => term.stop());
	try {
		await waitFor("the host's prompt", () => term.text().length > 200, 60_000);
		await Bun.sleep(1_500);
		if (c.prelude) await term.keys(c.prelude);
		await term.type("Ask the person about the export.");
		const first = await waitFor("the session to poll with its extension", async () => (await onlySession(server))?.outdated ?? null, 120_000);
		expect(first.loaded).toBe("0.28.98");
		expect(first.fix).toBe("update_extension");
		expect(first.update_command).toBe(c.updateCommand);
		expect(first.reload_command).toBe(c.reload);
		w.proof(`1. ${c.name} on 0.28.98 (on disk 0.28.98), Inbox ${INBOX_VERSION}: ${JSON.stringify(first)}`);

		registry.publish("0.28.99", repack(tarball, "0.28.99", packs), manifest);
		const mark = term.mark();
		const updated = await run(update);
		w.proof(`   $ ${c.updateCommand}  (exit ${updated.code}, ${updated.ms} ms)\n${updated.out.replace(/^/gm, "     ")}`);
		expect(updated.code).toBe(0);
		let t0 = Date.now();
		const second = await waitFor(`the Inbox to say ${c.reload}`, async () => {
			const outdated = (await onlySession(server))?.outdated;
			return outdated?.fix === "reload" ? outdated : null;
		}, 30_000);
		expect(second.reload_command).toBe(c.reload);
		expect(second.installed).toBe("0.28.99");
		w.proof(`2. on disk 0.28.99 under the running session: the Inbox said ${JSON.stringify(second)} ${Date.now() - t0} ms after the update finished`);
		const said = await waitFor("the session's own notice", () => (/Plannotator was updated from 0\.28\.98 to 0\.28\.99[^\n]*/.exec(term.since(mark).replace(/\s+/g, " ")) ?? [null])[0], 30_000);
		expect(said).toContain(`Type ${c.reload}`);
		w.proof(`   the session said: "${said.slice(0, 160)}"`);
		const list = (await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads?archived=exclude`)).json()) as { restart_agents?: unknown };
		w.proof(`   list restart_agents: ${JSON.stringify(list.restart_agents ?? null)}`);
		await shootAgents(server.port, `real-${c.name}-updated-on-disk`);

		t0 = Date.now();
		await term.type(c.reload);
		const after = await waitFor(`a session to report 0.28.99 after ${c.reload}`, async () => (await piSessions(server)).find((row) => row.plugin === "0.28.99" && row.outdated === null), 120_000);
		w.proof(`3. typed ${c.reload}: session ${after.session} reported ${after.plugin} with no line ${Date.now() - t0} ms later`);
		// Oh My Pi's /restart is a new process: the old one's connection is gone, and the Inbox lets it go once it stops polling.
		await waitFor("no session left on the old version", async () => (await piSessions(server)).every((row) => row.outdated === null), 60_000);
		w.proof(`   no session left on 0.28.98 (no line anywhere) ${Date.now() - t0} ms after ${c.reload}`);
	} finally {
		if (process.env.INBOX_PROOF_DIR) {
			const dir = join(process.env.INBOX_PROOF_DIR, "pi-reload");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, `${c.name}-terminal.txt`), term.text());
		}
	}
}

describe.skipIf(!proofOn)("Pi and Oh My Pi: the reload line, on the real hosts in a terminal", () => {
	test("Pi: pi update --extensions, then /reload; each step shows within seconds and the line goes", () => prove(PI), 900_000);
	test.skipIf(!ompBin)("Oh My Pi: omp plugin upgrade, then /restart", () => prove(OMP), 900_000);
});
