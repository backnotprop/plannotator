import { createServer } from "node:http";
import { dirname, resolve as resolvePath } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { contentHash, deleteDraft } from "../generated/draft.js";
import { saveToHistory, getPlanVersion, getVersionCount, listVersions } from "../generated/storage.js";
import { htmlDiff } from "../generated/html-diff.js";
import { saveConfig, detectGitUser, getServerConfig, loadConfig, resolveSharingEnabled, resolveAnnotateHistory } from "../generated/config.js";
import { disabledSourceSave, type SourceSaveRequest } from "../generated/source-save.js";
import { getAnnotateReferenceRootPaths } from "../generated/annotate-reference-roots-node.js";
import {
	createSourceSaveCapability,
	createSourceSaveCapabilityFromText,
	readSourceFileSnapshot,
	resolveFolderSourceFile,
	resolveFolderSourceFileForSave,
	saveSourceFileAtomic,
} from "../generated/source-save-node.js";

import {
	handleDraftRequest,
	handleFavicon,
	handleImageRequest,
	readDraftGenerationFromBody,
	readDraftGenerationFromUrl,
	handleSaveNotesRequest,
	handleUploadRequest,
} from "./handlers.js";
import { html, json, parseBody, requestUrl } from "./helpers.js";
import { createPiAIRuntime, handlePiAIRequest } from "./ai-runtime.js";

import { isRemoteSession, listenOnPort } from "./network.js";
import { getAvailableOpenInApps, openFileInApp } from "./open-in-apps.js";

import { getRepoInfo } from "./project.js";
import {
	handleDocRequest,
	handleDocExistsRequest,
	handleFileBrowserRequest,
	handleObsidianVaultsRequest,
	handleObsidianFilesRequest,
	handleObsidianDocRequest,
} from "./reference.js";
import { handleFileBrowserStreamRequest } from "./file-browser-watch.js";
import { resolveUserPath, warmFileListCache } from "../generated/resolve-file.js";
import { createExternalAnnotationHandler } from "./external-annotations.js";
import { createNodeAgentTerminalBridge } from "./agent-terminal.js";
import {
	HTML_ASSET_ROUTE_PREFIX,
	encodeHtmlAssetPath,
	htmlAssetContentType,
	normalizeHtmlAssetRoutePath,
	rewriteHtmlAssetReferences,
} from "../generated/html-assets.js";
import { inlineHtmlLocalAssets, isWithinDirectory, MAX_HTML_ASSET_BYTES, resolveOpenInTarget } from "../generated/html-assets-node.js";
import {
	supportsAnnotateAgentTerminalMode,
	type AgentTerminalCapability,
} from "../generated/agent-terminal.js";

export interface AnnotateServerResult {
	port: number;
	portSource: "env" | "remote-default" | "random";
	url: string;
	waitForDecision: () => Promise<{ feedback: string; annotations: unknown[]; exit?: boolean; approved?: boolean; selectedMessageId?: string; feedbackScope?: "message" | "messages" }>;
	stop: () => void;
}

function createHtmlAssetRegistry() {
	const rootsByToken = new Map<string, string>();
	const tokensByRoot = new Map<string, string>();

	function register(baseDir: string): string {
		const root = resolvePath(baseDir);
		const existing = tokensByRoot.get(root);
		if (existing) return existing;
		const token = randomUUID().replace(/-/g, "").slice(0, 16);
		tokensByRoot.set(root, token);
		rootsByToken.set(token, root);
		return token;
	}

	function rewriteHtml(htmlContent: string, htmlFilePath: string): string {
		if (/^https?:\/\//i.test(htmlFilePath)) return htmlContent;
		try {
			const token = register(dirname(resolvePath(htmlFilePath)));
			return rewriteHtmlAssetReferences(
				htmlContent,
				(assetPath) => `${HTML_ASSET_ROUTE_PREFIX}/${token}/${encodeHtmlAssetPath(assetPath)}`,
			);
		} catch {
			return htmlContent;
		}
	}

	function inlineHtml(htmlContent: string, htmlFilePath: string): string {
		return inlineHtmlLocalAssets(htmlContent, htmlFilePath);
	}

	function handle(res: import("node:http").ServerResponse, url: URL): boolean {
		const prefix = `${HTML_ASSET_ROUTE_PREFIX}/`;
		if (!url.pathname.startsWith(prefix)) return false;

		const rest = url.pathname.slice(prefix.length);
		const slash = rest.indexOf("/");
		if (slash <= 0) {
			json(res, { error: "Missing asset token or path" }, 404);
			return true;
		}

		const token = rest.slice(0, slash);
		const root = rootsByToken.get(token);
		if (!root) {
			json(res, { error: "Unknown asset root" }, 404);
			return true;
		}

		const assetPath = normalizeHtmlAssetRoutePath(rest.slice(slash + 1));
		if (!assetPath) {
			json(res, { error: "Invalid asset path" }, 400);
			return true;
		}

		const contentType = htmlAssetContentType(assetPath);
		if (!contentType) {
			json(res, { error: "Unsupported asset type" }, 415);
			return true;
		}

		const resolved = resolvePath(root, assetPath);
		if (!isWithinDirectory(resolved, root)) {
			json(res, { error: "Access denied" }, 403);
			return true;
		}

		try {
			if (!existsSync(resolved)) {
				json(res, { error: "Asset not found" }, 404);
				return true;
			}
			const stat = statSync(resolved);
			if (stat.size > MAX_HTML_ASSET_BYTES) {
				json(res, { error: "Asset too large" }, 413);
				return true;
			}
			res.writeHead(200, {
				"Content-Type": contentType,
				"Cache-Control": "no-store",
				"Access-Control-Allow-Origin": "*",
			});
			res.end(readFileSync(resolved));
		} catch {
			json(res, { error: "Failed to read asset" }, 500);
		}
		return true;
	}

	return { rewriteHtml, inlineHtml, handle };
}

export async function startAnnotateServer(options: {
	markdown: string;
	filePath: string;
	htmlContent: string;
	origin?: string;
	mode?: string;
	folderPath?: string;
	recentMessages?: { messageId: string; text: string; timestamp?: string }[];
	sharingEnabled?: boolean;
	shareBaseUrl?: string;
	pasteApiUrl?: string;
	sourceInfo?: string;
	sourceConverted?: boolean;
	gate?: boolean;
	rawHtml?: string;
	renderHtml?: boolean;
	convertHtml?: boolean;
	agentCwd?: string;
	/** Project name for keying per-file version history (powers the annotate version diff). */
	project?: string;
}): Promise<AnnotateServerResult> {
	const gitUser = detectGitUser();
	const sharingEnabled =
		options.sharingEnabled ?? resolveSharingEnabled(loadConfig());
	const shareBaseUrl =
		(options.shareBaseUrl ?? process.env.PLANNOTATOR_SHARE_URL) || undefined;
	const pasteApiUrl =
		(options.pasteApiUrl ?? process.env.PLANNOTATOR_PASTE_URL) || undefined;

	let resolveDecision!: (result: {
		feedback: string;
		annotations: unknown[];
		exit?: boolean;
		approved?: boolean;
		selectedMessageId?: string;
		feedbackScope?: "message" | "messages";
	}) => void;
	const decisionPromise = new Promise<{
		feedback: string;
		annotations: unknown[];
		exit?: boolean;
		approved?: boolean;
		selectedMessageId?: string;
		feedbackScope?: "message" | "messages";
	}>((r) => {
		resolveDecision = r;
	});

	// Folder annotation has no stable markdown body, so key drafts by folder path instead.
	const draftSource =
		options.mode === "annotate-folder" && options.folderPath
			? `folder:${resolvePath(options.folderPath)}`
			: options.renderHtml && options.rawHtml ? options.rawHtml : options.markdown;
	const draftKey = contentHash(draftSource);

	// Per-file version history → powers the native version diff in annotate mode.
	// Unlike the plan flow (slug = first-heading + date), annotate keys history by
	// file path so re-opening the same file groups its versions across edits even
	// when headings change. Diff content is the markdown, or the raw HTML source
	// when rendering HTML. Only single local files (not URLs/folders/messages).
	const annotateProjectName = options.project ?? "_unknown";
	let annotateHistory:
		| {
				slug: string;
				diffCurrent: string;
				previousPlan: string | null;
				versionInfo: { version: number; totalVersions: number; project: string };
		  }
		| null = null;
	{
		const historyContent = options.renderHtml && options.rawHtml ? options.rawHtml : options.markdown;
		const eligible =
			(options.mode || "annotate") === "annotate" &&
			!/^https?:\/\//i.test(options.filePath) &&
			historyContent.length > 0 &&
			resolveAnnotateHistory(loadConfig());
		if (eligible) {
			const base =
				(options.filePath.split(/[\\/]/).pop() || "document")
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-+|-+$/g, "")
					.slice(0, 60) || "document";
			const slug = `annotate-${base}-${contentHash(resolvePath(options.filePath)).slice(0, 8)}`;
			// History is an enhancement, never a gate: a read-only/full data dir
			// must degrade to stateless annotate (no version diff), not fail the
			// whole session before the UI ever opens. Mirrors packages/server.
			try {
				const saved = saveToHistory(annotateProjectName, slug, historyContent);
				const previousPlan =
					saved.version > 1
						? getPlanVersion(annotateProjectName, slug, saved.version - 1)
						: null;
				annotateHistory = {
					slug,
					diffCurrent: historyContent,
					previousPlan,
					versionInfo: {
						version: saved.version,
						totalVersions: getVersionCount(annotateProjectName, slug),
						project: annotateProjectName,
					},
				};
			} catch (error) {
				console.error(
					`[plannotator] warning: annotate history unavailable (${error instanceof Error ? error.message : String(error)}); continuing without version diff`,
				);
			}
		}
	}

	// Detect repo info (cached for this session)
	const repoInfo = getRepoInfo();

	const externalAnnotations = createExternalAnnotationHandler("plan");
	const aiRuntime = await createPiAIRuntime();
	const htmlAssets = createHtmlAssetRegistry();
	let agentTerminalCapability: AgentTerminalCapability = {
		enabled: false,
		reason: "unsupported-runtime",
	};

	function isAllowedHtmlSharePath(targetPath: string): boolean {
		const roots = new Set<string>([process.cwd()]);
		if (options.folderPath) roots.add(options.folderPath);
		if (!/^https?:\/\//i.test(options.filePath)) roots.add(dirname(options.filePath));
		for (const root of roots) {
			if (isWithinDirectory(targetPath, root)) return true;
		}
		return false;
	}

	function handleShareHtml(res: import("node:http").ServerResponse, url: URL): void {
		if (/^https?:\/\//i.test(options.filePath)) {
			json(res, { error: "Raw HTML sharing is unavailable for URL annotations" }, 400);
			return;
		}

		const sourcePath = resolvePath(options.filePath);
		const requestedPath = url.searchParams.get("path")
			? resolvePath(url.searchParams.get("path")!)
			: sourcePath;
		if (!/\.html?$/i.test(requestedPath)) {
			json(res, { error: "Share HTML is only available for HTML documents" }, 400);
			return;
		}
		if (!isAllowedHtmlSharePath(requestedPath)) {
			json(res, { error: "Access denied" }, 403);
			return;
		}

		try {
			const htmlContent = options.renderHtml && options.rawHtml && requestedPath === sourcePath
				? options.rawHtml
				: readFileSync(requestedPath, "utf-8");
			json(res, { shareHtml: htmlAssets.inlineHtml(htmlContent, requestedPath) });
		} catch {
			json(res, { error: "Failed to prepare share HTML" }, 500);
		}
	}

	const sourceMode = options.mode || "annotate";
	const singleFileSourceSaveEligible =
		sourceMode === "annotate" &&
		!options.sourceConverted &&
		!(options.renderHtml && options.rawHtml) &&
		!/^https?:\/\//i.test(options.filePath);
	const initialSingleFileSourceSave = singleFileSourceSaveEligible
		? createSourceSaveCapability("single-file", options.filePath)
		: null;
	const initialSingleFileSourcePath = singleFileSourceSaveEligible
		? initialSingleFileSourceSave?.enabled
			? initialSingleFileSourceSave.path
			: resolveUserPath(options.filePath)
		: null;
	const openedSourceFilePaths = new Set<string>();
	if (initialSingleFileSourcePath) openedSourceFilePaths.add(initialSingleFileSourcePath);
	const getPrimarySource = () => {
		const mode = options.mode || "annotate";
		if (mode === "annotate-last") {
			return { plan: options.markdown, sourceSave: disabledSourceSave("message-mode") };
		}
		if (mode === "annotate-folder") {
			return { plan: options.markdown, sourceSave: disabledSourceSave("folder-mode") };
		}
		if (options.renderHtml && options.rawHtml) {
			return { plan: options.markdown, sourceSave: disabledSourceSave("html-render") };
		}
		if (options.sourceConverted) {
			return { plan: options.markdown, sourceSave: disabledSourceSave("converted-source") };
		}
		if (/^https?:\/\//i.test(options.filePath)) {
			return { plan: options.markdown, sourceSave: disabledSourceSave("not-local-file") };
		}

		const sourceSave = createSourceSaveCapability("single-file", initialSingleFileSourcePath ?? options.filePath);
		if (!sourceSave.enabled) {
			if (sourceSave.reason === "missing-file" && initialSingleFileSourcePath) {
				const missingSourceSave = createSourceSaveCapabilityFromText("single-file", initialSingleFileSourcePath, options.markdown);
				if (missingSourceSave.enabled) {
					return { plan: options.markdown, sourceSave: missingSourceSave };
				}
			}
			return { plan: options.markdown, sourceSave };
		}

		try {
			const snapshot = readSourceFileSnapshot(sourceSave.path);
			return {
				plan: snapshot.text,
				sourceSave: {
					...sourceSave,
					hash: snapshot.hash,
					mtimeMs: snapshot.mtimeMs,
					size: snapshot.size,
					eol: snapshot.eol,
				},
			};
		} catch {
			return { plan: options.markdown, sourceSave: disabledSourceSave("unreadable-file") };
		}
	};

	const getReferenceRootPaths = () => getAnnotateReferenceRootPaths({
		mode: options.mode || "annotate",
		filePath: options.filePath,
		folderPath: options.folderPath,
		initialSingleFileSourcePath,
	});

	const server = createServer(async (req, res) => {
		const url = requestUrl(req);

		if (await externalAnnotations.handle(req, res, url)) return;
		if (url.pathname.startsWith("/api/ai/") && await handlePiAIRequest(req, res, url, aiRuntime)) return;

		if (url.pathname === "/api/plan" && req.method === "GET") {
			const displayRawHtml = options.renderHtml && options.rawHtml
				? htmlAssets.rewriteHtml(options.rawHtml, options.filePath)
				: undefined;
			// For HTML, render the version diff as the real page with inline
			// <ins>/<del> highlights (tag-aware htmlDiff), asset-rewritten the
			// same way as the live page so it renders identically.
			const diffHtml =
				options.renderHtml && options.rawHtml && annotateHistory?.previousPlan
					? htmlAssets.rewriteHtml(htmlDiff(annotateHistory.previousPlan, options.rawHtml), options.filePath)
					: undefined;
			const primarySource = getPrimarySource();
			json(res, {
				plan: primarySource.plan,
				origin: options.origin ?? "pi",
				mode: options.mode || "annotate",
				filePath: options.filePath,
				sourceInfo: options.sourceInfo,
				sourceConverted: options.sourceConverted ?? false,
				sourceSave: primarySource.sourceSave,
				gate: options.gate ?? false,
				renderAs: displayRawHtml ? 'html' : 'markdown',
				...(displayRawHtml ? { rawHtml: displayRawHtml } : {}),
				...(diffHtml ? { diffHtml } : {}),
				convertHtml: options.convertHtml ?? false,
				...(annotateHistory
					? {
							previousPlan: annotateHistory.previousPlan,
							versionInfo: annotateHistory.versionInfo,
							diffCurrent: annotateHistory.diffCurrent,
					  }
					: {}),
				sharingEnabled,
				shareBaseUrl,
				pasteApiUrl,
				repoInfo,
				projectRoot: options.folderPath || process.cwd(),
				serverConfig: getServerConfig(gitUser),
				agentTerminal: agentTerminalCapability,
				...(options.recentMessages ? { recentMessages: options.recentMessages } : {}),
			});
		} else if (url.pathname === "/api/plan/version" && req.method === "GET") {
			// fetch a specific version of the annotated file (version diff base picker)
			if (!annotateHistory) {
				json(res, { error: "No version history" }, 404);
				return;
			}
			const vParam = url.searchParams.get("v");
			const v = vParam ? parseInt(vParam, 10) : NaN;
			if (isNaN(v) || v < 1) {
				json(res, { error: "Invalid version number" }, 400);
				return;
			}
			const content = getPlanVersion(annotateProjectName, annotateHistory.slug, v);
			if (content === null) {
				json(res, { error: "Version not found" }, 404);
				return;
			}
			json(res, { plan: content, version: v });
		} else if (url.pathname === "/api/plan/versions" && req.method === "GET") {
			// list all stored versions of the annotated file (Version Browser)
			if (!annotateHistory) {
				json(res, { project: annotateProjectName, slug: null, versions: [] });
				return;
			}
			json(res, {
				project: annotateProjectName,
				slug: annotateHistory.slug,
				versions: listVersions(annotateProjectName, annotateHistory.slug),
			});
		} else if (url.pathname === "/api/share-html" && req.method === "GET") {
			handleShareHtml(res, url);
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
		} else if (htmlAssets.handle(res, url)) {
			return;
		} else if (url.pathname === "/api/upload" && req.method === "POST") {
			await handleUploadRequest(req, res);
		} else if (url.pathname === "/api/open-in/apps" && req.method === "GET") {
			// Remote/headless sessions can't open apps on the user's machine, and
			// URL annotations have no local file to reveal — report unavailable so
			// the UI hides the control entirely.
			const urlSource = /^https?:\/\//i.test(options.filePath);
			if (isRemoteSession() || urlSource) {
				json(res, { available: false, apps: [] });
				return;
			}
			json(res, { available: true, apps: getAvailableOpenInApps() });
		} else if (url.pathname === "/api/open-in" && req.method === "POST") {
			if (isRemoteSession() || /^https?:\/\//i.test(options.filePath)) {
				json(res, { ok: false, error: "Open in app is unavailable for this source" }, 400);
				return;
			}
			try {
				const body = await parseBody(req);
				const filePath = body.filePath;
				if (typeof filePath !== "string" || !filePath) {
					json(res, { ok: false, error: "Missing filePath" }, 400);
					return;
				}
				const appId = typeof body.appId === "string" ? body.appId : undefined;
				// Confine opens to the same reference roots /api/doc serves from,
				// so any linked doc the user can view can also be opened.
				const abs = resolveOpenInTarget(filePath, null, getReferenceRootPaths);
				if (abs == null) {
					json(res, { ok: false, error: "Path is outside the allowed directory" }, 403);
					return;
				}
				const result = await openFileInApp(abs, appId);
				json(res, result, 200);
			} catch (err) {
				json(
					res,
					{ ok: false, error: err instanceof Error ? err.message : "Failed to open file" },
					500,
				);
			}
		} else if (url.pathname === "/api/draft") {
			await handleDraftRequest(req, res, draftKey);
		} else if (url.pathname === "/api/doc" && req.method === "GET") {
			// Inject source file's directory as base for relative path resolution.
			// Skip for URL annotations — there's no local directory to resolve against.
			if (!url.searchParams.has("base") && options.filePath && !/^https?:\/\//i.test(options.filePath)) {
				url.searchParams.set("base", options.mode === "annotate-folder" && options.folderPath ? options.folderPath : dirname(resolvePath(options.filePath)));
			}
			if (options.convertHtml && !url.searchParams.has("convert")) {
				url.searchParams.set("convert", "1");
			}
			await handleDocRequest(res, url, {
				rewriteHtml: htmlAssets.rewriteHtml,
				sourceSaveFilePath: singleFileSourceSaveEligible
					? initialSingleFileSourcePath ?? options.filePath
					: undefined,
				sourceSaveFolderPath: options.mode === "annotate-folder" ? options.folderPath : undefined,
				onSourceDocumentServed: (path) => openedSourceFilePaths.add(path),
				rootPaths: getReferenceRootPaths(),
			});
		} else if (url.pathname === "/api/source/save" && req.method === "POST") {
			let body: SourceSaveRequest;
			try {
				body = (await parseBody(req)) as unknown as SourceSaveRequest;
			} catch {
				json(res, { ok: false, code: "invalid-request", message: "Invalid JSON body." }, 400);
				return;
			}

			if (typeof body.text !== "string" || typeof body.baseHash !== "string") {
				json(res, { ok: false, code: "invalid-request", message: "Expected text and baseHash." }, 400);
				return;
			}

			let targetPath: string | null = null;
			if (singleFileSourceSaveEligible) {
				const capability = createSourceSaveCapability("single-file", initialSingleFileSourcePath ?? options.filePath);
				targetPath = capability.enabled ? capability.path : initialSingleFileSourcePath;
			} else if (options.mode === "annotate-folder" && options.folderPath && typeof body.path === "string") {
				targetPath = body.allowMissingBase
					? resolveFolderSourceFileForSave(body.path, options.folderPath)
					: resolveFolderSourceFile(body.path, options.folderPath);
				if (
					body.allowMissingBase &&
					targetPath &&
					!existsSync(targetPath) &&
					!openedSourceFilePaths.has(targetPath)
				) {
					targetPath = null;
				}
			}

			if (!targetPath) {
				json(res, { ok: false, code: "not-writable", message: "This document cannot be saved to a file." }, 403);
				return;
			}

			const result = saveSourceFileAtomic(targetPath, body.text, body.baseHash, {
				allowMissingBase: body.allowMissingBase === true,
				missingBaseEol: body.baseEol,
				allowedRoot: options.mode === "annotate-folder" ? options.folderPath : undefined,
			});
			const status = result.ok
				? 200
				: result.code === "conflict"
					? 409
					: result.code === "invalid-request"
						? 400
						: result.code === "not-writable"
							? 403
							: 500;
			json(res, result, status);
		} else if (url.pathname === "/api/doc/exists" && req.method === "POST") {
			await handleDocExistsRequest(res, req, { rootPaths: getReferenceRootPaths() });
		} else if (url.pathname === "/api/obsidian/vaults") {
			handleObsidianVaultsRequest(res);
		} else if (url.pathname === "/api/reference/obsidian/files" && req.method === "GET") {
			handleObsidianFilesRequest(res, url);
		} else if (url.pathname === "/api/reference/obsidian/doc" && req.method === "GET") {
			handleObsidianDocRequest(res, url);
		} else if (url.pathname === "/api/reference/files" && req.method === "GET") {
			await handleFileBrowserRequest(res, url);
		} else if (url.pathname === "/api/reference/files/stream" && req.method === "GET") {
			handleFileBrowserStreamRequest(req, res, url);
			return;
		} else if (url.pathname === "/favicon.svg") {
			handleFavicon(res);
		} else if (url.pathname === "/api/exit" && req.method === "POST") {
			deleteDraft(draftKey, readDraftGenerationFromUrl(req));
			resolveDecision({ feedback: "", annotations: [], exit: true });
			json(res, { ok: true });
		} else if (url.pathname === "/api/approve" && req.method === "POST") {
			deleteDraft(draftKey, readDraftGenerationFromUrl(req));
			resolveDecision({ feedback: "", annotations: [], approved: true });
			json(res, { ok: true });
		} else if (url.pathname === "/api/feedback" && req.method === "POST") {
			try {
				const body = await parseBody(req);
				deleteDraft(draftKey, readDraftGenerationFromBody(body));
				resolveDecision({
					feedback: (body.feedback as string) || "",
					annotations: (body.annotations as unknown[]) || [],
					selectedMessageId: typeof body.selectedMessageId === "string" ? body.selectedMessageId : undefined,
					feedbackScope: body.feedbackScope === "messages" ? "messages" : body.feedbackScope === "message" ? "message" : undefined,
				});
				json(res, { ok: true });
			} catch (err) {
				const message = err instanceof Error ? err.message : "Failed to process feedback";
				json(res, { error: message }, 500);
			}
		} else if (url.pathname === "/api/save-notes" && req.method === "POST") {
			await handleSaveNotesRequest(req, res);
		} else {
			html(res, options.htmlContent);
		}
	});
	const agentTerminal = await createNodeAgentTerminalBridge({
		enabled: supportsAnnotateAgentTerminalMode(options.mode || "annotate"),
		cwd: options.agentCwd ?? process.cwd(),
		server,
	});
	agentTerminalCapability = agentTerminal.capability;

	const { port, portSource } = await listenOnPort(server);

	// Mirror the Bun server: bind first, then warm through the async shared walk.
	void warmFileListCache(process.cwd(), "code");

	return {
		port,
		portSource,
		url: `http://localhost:${port}`,
		waitForDecision: () => decisionPromise,
		stop: () => {
			aiRuntime?.dispose();
			agentTerminal.dispose();
			server.close();
		},
	};
}
