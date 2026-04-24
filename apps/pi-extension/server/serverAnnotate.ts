import { createServer } from "node:http";
import { dirname, resolve as resolvePath } from "node:path";

import { contentHash, deleteDraft } from "../generated/draft.js";
import { saveConfig, detectGitUser, getServerConfig } from "../generated/config.js";

import {
	handleDraftRequest,
	handleFavicon,
	handleImageRequest,
	handleUploadRequest,
} from "./handlers.js";
import { html, json, parseBody, requestUrl } from "./helpers.js";

import { listenOnPort } from "./network.js";

import { getRepoInfo } from "./project.js";
import {
	handleDocRequest,
	handleFileBrowserRequest,
	handleObsidianVaultsRequest,
	handleObsidianFilesRequest,
	handleObsidianDocRequest,
} from "./reference.js";
import { createExternalAnnotationHandler } from "./external-annotations.js";

export interface AnnotateServerResult {
	port: number;
	portSource: "env" | "remote-default" | "random";
	url: string;
	waitForDecision: () => Promise<{ feedback: string; annotations: unknown[]; exit?: boolean; approved?: boolean }>;
	stop: () => void;
}

export async function startAnnotateServer(options: {
	markdown: string;
	filePath: string;
	htmlContent: string;
	origin?: string;
	mode?: string;
	folderPath?: string;
	sharingEnabled?: boolean;
	shareBaseUrl?: string;
	pasteApiUrl?: string;
	sourceInfo?: string;
	gate?: boolean;
}): Promise<AnnotateServerResult> {
	const gitUser = detectGitUser();
	const sharingEnabled =
		options.sharingEnabled ?? process.env.PLANNOTATOR_SHARE !== "disabled";
	const shareBaseUrl =
		(options.shareBaseUrl ?? process.env.PLANNOTATOR_SHARE_URL) || undefined;
	const pasteApiUrl =
		(options.pasteApiUrl ?? process.env.PLANNOTATOR_PASTE_URL) || undefined;

	let resolveDecision!: (result: {
		feedback: string;
		annotations: unknown[];
		exit?: boolean;
		approved?: boolean;
	}) => void;
	const decisionPromise = new Promise<{
		feedback: string;
		annotations: unknown[];
		exit?: boolean;
		approved?: boolean;
	}>((r) => {
		resolveDecision = r;
	});

	// Folder annotation has no stable markdown body, so key drafts by folder path instead.
	const draftSource =
		options.mode === "annotate-folder" && options.folderPath
			? `folder:${resolvePath(options.folderPath)}`
			: options.markdown;
	const draftKey = contentHash(draftSource);

	// Detect repo info (cached for this session)
	const repoInfo = getRepoInfo();

	const externalAnnotations = createExternalAnnotationHandler("plan");

	const server = createServer(async (req, res) => {
		const url = requestUrl(req);

		if (await externalAnnotations.handle(req, res, url)) return;

		if (url.pathname === "/api/plan" && req.method === "GET") {
			json(res, {
				plan: options.markdown,
				origin: options.origin ?? "pi",
				mode: options.mode || "annotate",
				filePath: options.filePath,
				sourceInfo: options.sourceInfo,
				gate: options.gate ?? false,
				sharingEnabled,
				shareBaseUrl,
				pasteApiUrl,
				repoInfo,
				projectRoot: options.folderPath || process.cwd(),
				serverConfig: getServerConfig(gitUser),
			});
		} else if (url.pathname === "/api/config" && req.method === "POST") {
			try {
				const body = (await parseBody(req)) as { displayName?: string; diffOptions?: Record<string, unknown>; conventionalComments?: boolean };
				const toSave: Record<string, unknown> = {};
				if (body.displayName !== undefined) toSave.displayName = body.displayName;
				if (body.diffOptions !== undefined) toSave.diffOptions = body.diffOptions;
				if (body.conventionalComments !== undefined) toSave.conventionalComments = body.conventionalComments;
				if (Object.keys(toSave).length > 0) saveConfig(toSave as Parameters<typeof saveConfig>[0]);
				json(res, { ok: true });
			} catch {
				json(res, { error: "Invalid request" }, 400);
			}
		} else if (url.pathname === "/api/image") {
			handleImageRequest(res, url);
		} else if (url.pathname === "/api/upload" && req.method === "POST") {
			await handleUploadRequest(req, res);
		} else if (url.pathname === "/api/draft") {
			await handleDraftRequest(req, res, draftKey);
		} else if (url.pathname === "/api/doc" && req.method === "GET") {
			// Inject source file's directory as base for relative path resolution.
			// Skip for URL annotations — there's no local directory to resolve against.
			if (!url.searchParams.has("base") && options.filePath && !/^https?:\/\//i.test(options.filePath)) {
				url.searchParams.set("base", dirname(resolvePath(options.filePath)));
			}
			handleDocRequest(res, url);
		} else if (url.pathname === "/api/obsidian/vaults") {
			handleObsidianVaultsRequest(res);
		} else if (url.pathname === "/api/reference/obsidian/files" && req.method === "GET") {
			handleObsidianFilesRequest(res, url);
		} else if (url.pathname === "/api/reference/obsidian/doc" && req.method === "GET") {
			handleObsidianDocRequest(res, url);
		} else if (url.pathname === "/api/reference/files" && req.method === "GET") {
			handleFileBrowserRequest(res, url);
		} else if (url.pathname === "/favicon.svg") {
			handleFavicon(res);
		} else if (url.pathname === "/api/exit" && req.method === "POST") {
			deleteDraft(draftKey);
			resolveDecision({ feedback: "", annotations: [], exit: true });
			json(res, { ok: true });
		} else if (url.pathname === "/api/approve" && req.method === "POST") {
			deleteDraft(draftKey);
			resolveDecision({ feedback: "", annotations: [], approved: true });
			json(res, { ok: true });
		} else if (url.pathname === "/api/feedback" && req.method === "POST") {
			try {
				const body = await parseBody(req);
				deleteDraft(draftKey);
				resolveDecision({
					feedback: (body.feedback as string) || "",
					annotations: (body.annotations as unknown[]) || [],
				});
				json(res, { ok: true });
			} catch (err) {
				const message = err instanceof Error ? err.message : "Failed to process feedback";
				json(res, { error: message }, 500);
			}
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
