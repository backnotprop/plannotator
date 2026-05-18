import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";

import {
	createFactsResult,
	createInterviewResult,
	type GoalSetupBundle,
	type GoalSetupFactResult,
	type GoalSetupQuestionAnswer,
	type GoalSetupResult,
} from "../generated/goal-setup.js";
import { saveConfig, detectGitUser, getServerConfig } from "../generated/config.js";

import {
	handleFavicon,
	handleImageRequest,
	handleUploadRequest,
} from "./handlers.js";
import { html, json, parseBody, requestUrl } from "./helpers.js";
import { listenOnPort } from "./network.js";
import { getRepoInfo } from "./project.js";

export interface GoalSetupServerResult {
	port: number;
	portSource: "env" | "remote-default" | "random";
	url: string;
	waitForDecision: () => Promise<{ result?: GoalSetupResult; exit?: boolean }>;
	stop: () => void;
}

function coerceAnswers(body: Record<string, unknown>): GoalSetupQuestionAnswer[] {
	const result = body.result as Record<string, unknown> | undefined;
	const answers = Array.isArray(body.answers)
		? body.answers
		: result && Array.isArray(result.answers)
			? result.answers
			: [];
	return answers as GoalSetupQuestionAnswer[];
}

function coerceFacts(body: Record<string, unknown>): GoalSetupFactResult[] {
	const result = body.result as Record<string, unknown> | undefined;
	const facts = Array.isArray(body.facts)
		? body.facts
		: result && Array.isArray(result.facts)
			? result.facts
			: [];
	return facts as GoalSetupFactResult[];
}

/** Detect if running inside WSL (Windows Subsystem for Linux). */
function detectWSL(): boolean {
	if (process.platform !== "linux") return false;
	if (os.release().toLowerCase().includes("microsoft")) return true;
	try {
		if (existsSync("/proc/version")) {
			const content = readFileSync("/proc/version", "utf-8").toLowerCase();
			return content.includes("wsl") || content.includes("microsoft");
		}
	} catch { /* ignore */ }
	return false;
}

export async function startGoalSetupServer(options: {
	bundle: GoalSetupBundle;
	htmlContent: string;
	origin?: string;
}): Promise<GoalSetupServerResult> {
	const gitUser = detectGitUser();
	const repoInfo = getRepoInfo();
	const wslFlag = detectWSL();

	let settled = false;
	let resolveDecision!: (result: { result?: GoalSetupResult; exit?: boolean }) => void;
	const decisionPromise = new Promise<{ result?: GoalSetupResult; exit?: boolean }>((resolve) => {
		resolveDecision = resolve;
	});
	const resolveOnce = (result: { result?: GoalSetupResult; exit?: boolean }) => {
		if (settled) return;
		settled = true;
		resolveDecision(result);
	};

	const server = createServer(async (req, res) => {
		const url = requestUrl(req);

		if ((url.pathname === "/api/plan" || url.pathname === "/api/goal-setup") && req.method === "GET") {
			json(res, {
				plan: "",
				origin: options.origin ?? "pi",
				mode: "goal-setup",
				goalSetup: options.bundle,
				sharingEnabled: false,
				repoInfo,
				projectRoot: process.cwd(),
				isWSL: wslFlag,
				serverConfig: getServerConfig(gitUser),
			});
		} else if (url.pathname === "/api/config" && req.method === "POST") {
			try {
				const body = (await parseBody(req)) as { displayName?: string; diffOptions?: Record<string, unknown>; conventionalComments?: boolean; conventionalLabels?: unknown[] | null };
				const toSave: Record<string, unknown> = {};
				if (body.displayName !== undefined) toSave.displayName = body.displayName;
				if (body.diffOptions !== undefined) toSave.diffOptions = body.diffOptions;
				if (body.conventionalComments !== undefined) toSave.conventionalComments = body.conventionalComments;
				if (body.conventionalLabels !== undefined) toSave.conventionalLabels = body.conventionalLabels;
				if (Object.keys(toSave).length > 0) saveConfig(toSave as Parameters<typeof saveConfig>[0]);
				json(res, { ok: true });
			} catch {
				json(res, { error: "Invalid request" }, 400);
			}
		} else if (url.pathname === "/api/image") {
			handleImageRequest(res, url);
		} else if (url.pathname === "/api/upload" && req.method === "POST") {
			await handleUploadRequest(req, res);
		} else if (url.pathname === "/api/goal-setup/submit" && req.method === "POST") {
			try {
				const body = await parseBody(req);
				const result = options.bundle.stage === "interview"
					? createInterviewResult(options.bundle, coerceAnswers(body))
					: createFactsResult(options.bundle, coerceFacts(body));
				resolveOnce({ result });
				json(res, { ok: true, result });
			} catch (err) {
				const message = err instanceof Error ? err.message : "Failed to submit result";
				json(res, { error: message }, 400);
			}
		} else if (url.pathname === "/api/exit" && req.method === "POST") {
			resolveOnce({ exit: true });
			json(res, { ok: true });
		} else if (url.pathname === "/favicon.svg") {
			handleFavicon(res);
		} else {
			html(res, options.htmlContent);
		}
	});

	const { port, portSource } = await listenOnPort(server);

	return {
		port,
		portSource,
		url: `http://localhost:${port}`,
		waitForDecision: () => decisionPromise,
		stop: () => server.close(),
	};
}
