import { execFileSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { json, toWebRequest } from "./helpers.js";

export interface PiAIRuntime {
	endpoints: Record<string, (req: Request) => Promise<Response>>;
	dispose: () => void;
}

interface CreatePiAIRuntimeOptions {
	cwd?: string;
	getCwd?: () => string;
}

function whichCmd(cmd: string): string | null {
	try {
		const bin = process.platform === "win32" ? "where" : "which";
		const output = execFileSync(bin, [cmd], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return output
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean) ?? null;
	} catch {
		return null;
	}
}

export async function createPiAIRuntime(options: CreatePiAIRuntimeOptions = {}): Promise<PiAIRuntime | null> {
	try {
		const ai = await import("../generated/ai/index.js");
		const cwd = options.cwd ?? process.cwd();
		const registry = new ai.ProviderRegistry();
		const sessionManager = new ai.SessionManager();
		const modelDiscovery: Promise<void>[] = [];

		try {
			await import("../generated/ai/providers/claude-agent-sdk.js");
			const claudePath = whichCmd("claude");
			const provider = await ai.createProvider({
				type: "claude-agent-sdk",
				cwd,
				...(claudePath && { claudeExecutablePath: claudePath }),
			});
			registry.register(provider);
		} catch {
			// Claude SDK not available.
		}

		try {
			await import("../generated/ai/providers/codex-sdk.js");
			await import("@openai/codex-sdk");
			const codexPath = whichCmd("codex");
			const provider = await ai.createProvider({
				type: "codex-sdk",
				cwd,
				...(codexPath && { codexExecutablePath: codexPath }),
			});
			registry.register(provider);
		} catch {
			// Codex SDK not available.
		}

		try {
			await import("../generated/ai/providers/pi-sdk-node.js");
			const piPath = whichCmd("pi");
			if (piPath) {
				const provider = await ai.createProvider({
					type: "pi-sdk",
					cwd,
					piExecutablePath: piPath,
				} as any);
				if (provider && "fetchModels" in provider) {
					modelDiscovery.push(
						(provider as { fetchModels: () => Promise<void> })
							.fetchModels()
							.catch(() => {}),
					);
				}
				registry.register(provider);
			}
		} catch {
			// Pi not available.
		}

		try {
			await import("../generated/ai/providers/opencode-sdk.js");
			const opencodePath = whichCmd("opencode");
			if (opencodePath) {
				const provider = await ai.createProvider({
					type: "opencode-sdk",
					cwd,
				});
				if (provider && "fetchModels" in provider) {
					modelDiscovery.push(
						(provider as { fetchModels: () => Promise<void> })
							.fetchModels()
							.catch(() => {}),
					);
				}
				registry.register(provider);
			}
		} catch {
			// OpenCode not available.
		}

		return {
			endpoints: ai.createAIEndpoints({
				registry,
				sessionManager,
				getCwd: options.getCwd,
				beforeCapabilities: async () => {
					await Promise.allSettled(modelDiscovery);
				},
			}),
			dispose: () => {
				sessionManager.disposeAll();
				registry.disposeAll();
			},
		};
	} catch {
		return null;
	}
}

export async function handlePiAIRequest(
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	runtime: PiAIRuntime | null,
): Promise<boolean> {
	if (!url.pathname.startsWith("/api/ai/")) return false;

	if (!runtime) {
		if (url.pathname === "/api/ai/capabilities" && req.method === "GET") {
			json(res, { available: false, providers: [] });
			return true;
		}
		json(res, { error: "AI backend not available" }, 503);
		return true;
	}

	const handler = runtime.endpoints[url.pathname];
	if (!handler) {
		json(res, { error: "Not found" }, 404);
		return true;
	}

	try {
		const webReq = toWebRequest(req);
		const webRes = await handler(webReq);
		const headers: Record<string, string> = {};
		webRes.headers.forEach((value, key) => {
			headers[key] = value;
		});
		res.writeHead(webRes.status, headers);
		if (webRes.body) {
			Readable.fromWeb(webRes.body as any).pipe(res);
		} else {
			res.end();
		}
	} catch (err) {
		json(res, { error: err instanceof Error ? err.message : "AI endpoint error" }, 500);
	}

	return true;
}
