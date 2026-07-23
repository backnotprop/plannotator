import type { Server as HttpServer } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

import {
	buildAgentTerminalWsPath,
	type AgentTerminalAgent,
	type AgentTerminalCapability,
} from "../generated/agent-terminal.ts";
import { isRemoteSession } from "./network.ts";
import type { PtyBackend, PtyExit, PtySession, PtySpawnOptions, Unsubscribe } from "@plannotator/webtui/core";

type WebTuiCore = typeof import("@plannotator/webtui/core");
type WebTuiServer = typeof import("@plannotator/webtui/server");
type BuildAgentLaunchPlan = WebTuiCore["buildAgentLaunchPlan"];

export type NodeAgentTerminalBridge = {
	capability: AgentTerminalCapability;
	dispose(): void;
};

export async function createNodeAgentTerminalBridge(args: {
	enabled: boolean;
	cwd: string;
	server: HttpServer;
}): Promise<NodeAgentTerminalBridge> {
	if (!args.enabled) {
		return createDisabledBridge({
			enabled: false,
			reason: "not-annotate-mode",
		});
	}

	if (isRemoteSession() && !isAgentTerminalRemoteEnabled()) {
		return createDisabledBridge({
			enabled: false,
			reason: "remote-disabled",
			message: "Agent terminal is disabled in remote mode. Set PLANNOTATOR_AGENT_TERMINAL_REMOTE=1 to enable it.",
		});
	}

	let core: WebTuiCore;
	let serverModule: WebTuiServer;
	try {
		[core, serverModule] = await Promise.all([
			import("@plannotator/webtui/core"),
			import("@plannotator/webtui/server"),
		]);
	} catch (err) {
		return createDisabledBridge({
			enabled: false,
			reason: "webtui-unavailable",
			message: err instanceof Error ? err.message : String(err),
		});
	}

	let baseBackend: PtyBackend;
	try {
		baseBackend = new serverModule.NodePtyBackend();
	} catch (err) {
		return createDisabledBridge({
			enabled: false,
			reason: "pty-unavailable",
			message: err instanceof Error ? err.message : String(err),
		});
	}

	const allowedAgents = new Set(core.listBuiltInAgents());
	const sessions = new Set<PtySession>();
	let spawnInFlight = false;
	const wsPath = buildAgentTerminalWsPath(randomBytes(18).toString("hex"));
	const backend: PtyBackend = {
		async spawn(options: PtySpawnOptions): Promise<PtySession> {
			if (spawnInFlight || sessions.size > 0) {
				throw new Error("An agent terminal is already running.");
			}
			const normalized = normalizeSpawnOptions(options, args.cwd, allowedAgents, core.buildAgentLaunchPlan);
			if (!normalized.ok) throw new Error(normalized.message);
			spawnInFlight = true;
			try {
				const session = wrapPtySession(await baseBackend.spawn(normalized.value));
				sessions.add(session);
				session.onExit(() => sessions.delete(session));
				return session;
			} finally {
				spawnInFlight = false;
			}
		},
	};
	const ptyServer = serverModule.createNodePtyWebSocketServer({
		server: args.server,
		path: wsPath,
		backend,
	});

	return {
		capability: {
			enabled: true,
			cwd: args.cwd,
			wsPath,
			agents: listAgents(core),
		},
		dispose() {
			for (const session of sessions) session.kill();
			sessions.clear();
			void ptyServer.close().catch(() => {});
		},
	};
}

function createDisabledBridge(
	capability: AgentTerminalCapability,
): NodeAgentTerminalBridge {
	return {
		capability,
		dispose() {},
	};
}

function wrapPtySession(session: PtySession): PtySession {
	let exited = false;
	const exitListeners = new Set<(event: PtyExit) => void>();
	let underlyingExitUnsubscribe: Unsubscribe | null = null;

	function markExited(exit: PtyExit): void {
		if (exited) return;
		exited = true;
		for (const listener of exitListeners) listener(exit);
		exitListeners.clear();
		underlyingExitUnsubscribe?.();
		underlyingExitUnsubscribe = null;
	}

	function markClosed(): void {
		markExited({ exitCode: null, signal: "closed" });
	}

	return {
		id: session.id,
		write(data) {
			if (exited) return;
			try {
				session.write(data);
			} catch {
				// Stale browser events can arrive after node-pty has closed its fd.
				markClosed();
			}
		},
		resize(cols, rows) {
			if (exited) return;
			try {
				session.resize(cols, rows);
			} catch {
				// Stale ResizeObserver/xterm events after process exit are harmless.
				markClosed();
			}
		},
		kill(signal) {
			if (exited) return;
			try {
				session.kill(signal);
			} catch {
				// The process may already have exited.
				markClosed();
			}
		},
		onData(callback) {
			return session.onData(callback);
		},
		onExit(callback) {
			exitListeners.add(callback);
			if (!underlyingExitUnsubscribe) {
				underlyingExitUnsubscribe = session.onExit(markExited);
			}
			return () => exitListeners.delete(callback);
		},
		getForegroundProcess: session.getForegroundProcess
			? async () => {
					if (exited || !session.getForegroundProcess) return null;
					try {
						return await session.getForegroundProcess();
					} catch {
						return null;
					}
				}
			: undefined,
		hasChildProcesses: session.hasChildProcesses
			? async () => {
					if (exited || !session.hasChildProcesses) return false;
					try {
						return await session.hasChildProcesses();
					} catch {
						return false;
					}
				}
			: undefined,
	};
}

export function normalizeSpawnOptions(
	options: PtySpawnOptions,
	cwd: string,
	allowedAgents: Set<string>,
	buildAgentLaunchPlan: BuildAgentLaunchPlan,
): { ok: true; value: PtySpawnOptions } | { ok: false; message: string } {
	if (!options.agent) {
		return { ok: false, message: "Agent terminal requires a built-in WebTUI agent." };
	}
	if (!allowedAgents.has(options.agent)) {
		return { ok: false, message: `Unknown WebTUI agent: ${options.agent}` };
	}
	const launch = buildAgentLaunchPlan({
		agent: options.agent,
		allowEmptyPromptLaunch: true,
	});
	const value: PtySpawnOptions = {
		agent: launch.agent,
		command: launch.command,
		cwd,
		startupCommandMode: "shell-ready",
	};
	const cols = normalizeTerminalDimension(options.cols);
	if (cols !== undefined) value.cols = cols;
	const rows = normalizeTerminalDimension(options.rows);
	if (rows !== undefined) value.rows = rows;
	if (Object.keys(launch.env).length > 0) value.env = launch.env;
	if (launch.preflightTrust) value.preflightTrust = launch.preflightTrust;
	return {
		ok: true,
		value,
	};
}

function normalizeTerminalDimension(value: unknown): number | undefined {
	if (!Number.isInteger(value) || (value as number) <= 0) return undefined;
	return Math.min(value as number, 1_000);
}

function isAgentTerminalRemoteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return /^(1|true|yes)$/i.test(env.PLANNOTATOR_AGENT_TERMINAL_REMOTE ?? "");
}

function listAgents(core: WebTuiCore): AgentTerminalAgent[] {
	return core.listBuiltInAgents().map((id) => {
		const config = core.BUILT_IN_AGENTS[id];
		return {
			id,
			name: formatAgentName(id),
			available: commandExists(config.detectCommand),
		};
	});
}

function commandExists(command: string): boolean {
	const pathValue = process.env.PATH;
	if (!pathValue) return false;
	const extensions =
		process.platform === "win32"
			? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
			: [""];

	for (const dir of pathValue.split(delimiter)) {
		for (const ext of extensions) {
			const candidate = join(dir, process.platform === "win32" ? command + ext : command);
			try {
				if (existsSync(candidate) && !statSync(candidate).isDirectory()) return true;
			} catch {
				// Keep scanning PATH.
			}
		}
	}
	return false;
}

function formatAgentName(id: string): string {
	const overrides: Record<string, string> = {
		amp: "Amp",
		claude: "Claude",
		codex: "Codex",
		copilot: "GitHub Copilot",
		gemini: "Gemini",
		opencode: "OpenCode",
		pi: "Pi",
	};
	if (overrides[id]) return overrides[id];
	return id
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}
