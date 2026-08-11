import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { dirname, resolve as resolvePath } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { contentHash, deleteDraft } from "../generated/draft.ts";
import { getPlanVersion, getVersionCount, listVersions } from "../generated/storage.ts";
import { computeAnnotateHistory, deriveAnnotateHistorySlug, persistAnnotateSubmission, type AnnotateHistoryResult } from "../generated/annotate-history.ts";
import { htmlDiff } from "../generated/html-diff.ts";
import { saveConfig, detectGitUser, getServerConfig, loadConfig, resolveAIEnabled, resolveSharingEnabled, resolveAnnotateHistory, type PromptRuntime } from "../generated/config.ts";
import { getAnnotateFileFeedbackTemplate, getAnnotateMessageFeedbackTemplate } from "../generated/prompts.ts";
import { disabledSourceSave, type SourceSaveRequest } from "../generated/source-save.ts";
import { getAnnotateReferenceRootPaths } from "../generated/annotate-reference-roots-node.ts";
import {
	createSourceSaveCapability,
	createSourceSaveCapabilityFromText,
	readSourceFileSnapshot,
	resolveFolderSourceFile,
	resolveFolderSourceFileForSave,
	saveSourceFileAtomic,
} from "../generated/source-save-node.ts";

import {
	handleDraftRequest,
	handleFavicon,
	handleImageRequest,
	handleReferenceSkillsRequest,
	handleReferenceSkillContentRequest,
	readDraftGenerationFromBody,
	readDraftGenerationFromUrl,
	handleSaveNotesRequest,
	handleUploadRequest,
} from "./handlers.ts";
import { handleApiNotFound, html, json, parseBody, requestUrl } from "./helpers.ts";
import { createPiAIRuntime, handlePiAIRequest } from "./ai-runtime.ts";

import { buildAdvertisedUrl, isRemoteSession, listenOnPort } from "./network.ts";
import { getAvailableOpenInApps, openFileInApp } from "./open-in-apps.ts";

import { getRepoInfo } from "./project.ts";
import {
	handleDocRequest,
	handleDocExistsRequest,
	handleFileBrowserRequest,
	handleObsidianVaultsRequest,
	handleObsidianFilesRequest,
	handleObsidianDocRequest,
	resolveAllowedDocPath,
	type FolderAnnotateHistory,
} from "./reference.ts";
import { handleFileBrowserStreamRequest } from "./file-browser-watch.ts";
import { resolveUserPath, warmFileListCache } from "../generated/resolve-file.ts";
import { createExternalAnnotationHandler } from "./external-annotations.ts";
import { createNodeAgentTerminalBridge } from "./agent-terminal.ts";
import {
	HTML_ASSET_ROUTE_PREFIX,
	encodeHtmlAssetPath,
	htmlAssetContentType,
	normalizeHtmlAssetRoutePath,
	rewriteHtmlAssetReferences,
} from "../generated/html-assets.ts";
import { inlineHtmlLocalAssets, isWithinDirectory, MAX_HTML_ASSET_BYTES, resolveOpenInTarget } from "../generated/html-assets-node.ts";
import {
	supportsAnnotateAgentTerminalMode,
	type AgentTerminalCapability,
} from "../generated/agent-terminal.ts";
import {
	ANNOTATE_CLIENT_LEASE_GRACE_MS,
	ANNOTATE_CLIENT_LEASE_HEARTBEAT_MS,
	ANNOTATE_CLIENT_LEASE_STREAM_PATH,
	createAnnotateClientLeaseStreamSession,
	createAnnotateClientLeaseTracker,
} from "../generated/annotate-client-lease.ts";
import { createAnnotateDecisionSettler } from "../generated/annotate-decision.ts";

export interface AnnotateServerResult {
	port: number;
	portSource: "env" | "remote-default" | "random";
	url: string;
	waitForDecision: () => Promise<{ feedback: string; annotations: unknown[]; exit?: boolean; approved?: boolean; selectedMessageId?: string; feedbackScope?: "message" | "messages" }>;
	stop: () => void;
}

function parseOptionalApprovalBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk) => {
			data += chunk;
		});
		req.on("error", reject);
		req.on("end", () => {
			if (!data.trim()) {
				resolve({});
				return;
			}
			try {
				const parsed = JSON.parse(data);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
					throw new Error("Expected a JSON object.");
				}
				resolve(parsed as Record<string, unknown>);
			} catch (err) {
				reject(err);
			}
		});
	});
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
	approvalNotesSupported?: boolean;
	clientLeaseSupported?: boolean;
	/** @internal Test-only timing overrides for the client-lease grace/heartbeat intervals — never sleeps real 30s in tests. */
	clientLeaseTestOverrides?: { graceMs?: number; heartbeatMs?: number };
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

	// Every decision producer goes through this: connected tabs and the client
	// lease below race, and a producer that loses must not delete the reviewer's
	// draft or report success for an outcome the caller never received.
	const decision = createAnnotateDecisionSettler(resolveDecision);
	const sendAlreadyDecided = (res: import("node:http").ServerResponse): void => {
		json(res, { error: "This review session has already been decided." }, 409);
	};

	// Last-client abandonment lease: once the tab's client-lease stream
	// disconnects (as reported by the transport) and stays disconnected for the
	// grace period with no reconnect, the decision resolves as dismissed
	// instead of hanging the Pi orchestration forever. Grace timing is bounded
	// only for clean disconnects; abrupt/half-open connection loss is detected
	// on a best-effort basis by the transport and can take longer than
	// graceMs to be noticed at all. See packages/shared/annotate-client-lease.ts
	// (vendored to generated/annotate-client-lease.ts by vendor.sh).
	const clientLeaseGraceMs = options.clientLeaseTestOverrides?.graceMs ?? ANNOTATE_CLIENT_LEASE_GRACE_MS;
	const clientLeaseHeartbeatMs = options.clientLeaseTestOverrides?.heartbeatMs ?? ANNOTATE_CLIENT_LEASE_HEARTBEAT_MS;
	const clientLease = createAnnotateClientLeaseTracker(
		() => decision.settle({ feedback: "", annotations: [], exit: true }),
		{ graceMs: clientLeaseGraceMs },
	);

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
	const annotateHistoryEnabled = resolveAnnotateHistory(loadConfig());
	// Single local file sessions are the only ones the annotate-history contract
	// covers: URL / folder / agent-message sessions never write session content
	// to the data dir. Both the version history below and the durable submit
	// records share this gate.
	const singleFileLocalAnnotate =
		(options.mode || "annotate") === "annotate" && !/^https?:\/\//i.test(options.filePath);
	let annotateHistory: AnnotateHistoryResult | null = null;
	{
		const historyContent = options.renderHtml && options.rawHtml ? options.rawHtml : options.markdown;
		const eligible =
			singleFileLocalAnnotate &&
			historyContent.length > 0 &&
			annotateHistoryEnabled;
		// History is an enhancement, never a gate: a read-only/full data dir
		// must degrade to stateless annotate (no version diff), not fail the
		// whole session before the UI ever opens. (computeAnnotateHistory never
		// throws — it logs and returns null on any storage error.)
		if (eligible) {
			annotateHistory = computeAnnotateHistory(annotateProjectName, resolvePath(options.filePath), historyContent);
		}
	}

	// Folder annotate: the same per-file version history, but run lazily the
	// first time a folder file is opened via /api/doc (not eagerly for every
	// file in the folder) and memoized per resolved absolute path for the life
	// of this server — reopening the same file in this session never re-snapshots.
	// The memo drops `diffCurrent` (it always equals the request's own content
	// and the client never reads it off /api/doc) — only slug/previousPlan/
	// versionInfo are retained.
	const folderAnnotateHistoryCache = new Map<string, FolderAnnotateHistory | null>();
	function computeFolderAnnotateHistory(resolvedFilePath: string, content: string): FolderAnnotateHistory | null {
		const cached = folderAnnotateHistoryCache.get(resolvedFilePath);
		if (cached !== undefined) return cached;
		const full = computeAnnotateHistory(annotateProjectName, resolvedFilePath, content);
		const result: FolderAnnotateHistory | null = full
			? { slug: full.slug, previousPlan: full.previousPlan, versionInfo: full.versionInfo }
			: null;
		folderAnnotateHistoryCache.set(resolvedFilePath, result);
		return result;
	}

	// Durable submit records (#678): the caller consuming waitForDecision() may
	// be gone (agent-side timeout) by the time the reviewer clicks submit —
	// settling the promise then deleting the draft would leave the submitted
	// feedback existing nowhere. persistAnnotateSubmission writes the record to
	// {DATA_DIR}/history/{project}/{slug}/submissions/{timestamp}.md (next to
	// the file's annotate version history) BEFORE the draft delete.
	//
	// annotateHistory opt-out policy: PLANNOTATOR_ANNOTATE_HISTORY=0 means "do
	// not write annotated content to the data dir", and submitted feedback
	// quotes that content, so the record is skipped and the legacy submit
	// behavior (draft deleted) is preserved unchanged. A missing/timed-out
	// consumer is not detectable in-process (the server cannot know its caller
	// stopped reading), so there is no narrower condition to key off.
	//
	// Scope: identical to the version-history gate above — single local files
	// only. annotate-last / URL / folder sessions were stateless before this
	// record existed and STAY stateless: their submissions quote agent messages
	// or fetched pages, which the documented annotateHistory contract never
	// covered writing to disk.
	//
	// Returns whether the draft delete may proceed: true when the record was
	// written, when there was no user content to lose, or when the session
	// does not persist; false only when a durable write was expected and
	// failed — the draft then stays behind as the recovery copy.
	const persistSubmittedDecision = (
		feedback: unknown,
		annotations: unknown,
		approved: boolean,
	): boolean => {
		// Defensive: /api/feedback does not type-validate its body (unlike
		// /api/approve), and a malformed value must degrade to the legacy
		// behavior (settle + delete draft + 200), never throw into a 500.
		const feedbackText = typeof feedback === "string" ? feedback : "";
		const annotationList = Array.isArray(annotations) ? annotations : [];
		if (!feedbackText.trim() && annotationList.length === 0) return true; // contentless (e.g. bare approve)
		if (!annotateHistoryEnabled) return true; // opt-out: stateless annotate sessions
		if (!singleFileLocalAnnotate) return true; // stateless modes stay stateless
		return (
			persistAnnotateSubmission({
				project: annotateProjectName,
				sessionPath: resolvePath(options.filePath),
				feedback: feedbackText,
				annotations: annotationList,
				approved,
			}) !== null
		);
	};

	// Detect repo info (cached for this session)
	const repoInfo = getRepoInfo();

	const externalAnnotations = createExternalAnnotationHandler("plan");
	const aiRuntime = resolveAIEnabled() ? await createPiAIRuntime() : null;
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

		// API: Client-lease SSE — see generated/annotate-client-lease.ts.
		// Only local direct structured annotate gates advertise and serve
		// this; other sessions get a 404.
		if (url.pathname === ANNOTATE_CLIENT_LEASE_STREAM_PATH && req.method === "GET") {
			if (!options.clientLeaseSupported) {
				res.writeHead(404);
				res.end("Client lease unavailable");
				return;
			}

			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			res.setTimeout(0);

			const session = createAnnotateClientLeaseStreamSession({
				tracker: clientLease,
				heartbeatMs: clientLeaseHeartbeatMs,
				write: (chunk) => {
					res.write(chunk);
				},
				endStream: () => res.end(),
			});

			// `req.on("close")` reliably fires on client disconnect; `res.on("close")`
			// is registered too as defense-in-depth for Node runtimes/versions where
			// only the response object emits it. `session.close()` is idempotent so a
			// double-fire is harmless.
			req.on("close", () => session.close());
			res.on("close", () => session.close());

			return;
		}

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
				approvalNotesSupported: options.approvalNotesSupported ?? false,
				clientLease: options.clientLeaseSupported
					? { enabled: true as const, reconnectGraceMs: clientLeaseGraceMs }
					: { enabled: false as const },
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
				// Resolved copy-wrapper templates (config-aware, placeholders
				// intact) so clipboard Copy matches what Send Feedback produces
				// instead of the plan-deny wrap (#1107). Resolved per request so
				// config edits mid-session behave like Send Feedback (which
				// resolves at submit time).
				feedbackTemplates: {
					fileFeedback: getAnnotateFileFeedbackTemplate(
						(options.origin ?? "pi") as PromptRuntime,
					),
					messageFeedback: getAnnotateMessageFeedbackTemplate(
						(options.origin ?? "pi") as PromptRuntime,
					),
				},
			});
		} else if (url.pathname === "/api/plan/version" && req.method === "GET") {
			// fetch a specific version of the annotated file (version diff base picker)
			//
			// Folder sessions pass `?path=` (optionally `&base=`) to identify which
			// file's history to read, resolved and containment-checked exactly like
			// /api/doc; the slug is always derived server-side from that resolved
			// path — a client-supplied slug is never accepted, since the history
			// lookup joins it into a filesystem path unsanitized. Without `path`,
			// behavior is unchanged: the single session's own history is used.
			const pathParam = url.searchParams.get("path");
			let slug: string;
			if (pathParam !== null) {
				const resolved = resolveAllowedDocPath(pathParam, url.searchParams.get("base"), {
					rootPaths: getReferenceRootPaths(),
				});
				if (resolved.kind === "denied") {
					json(res, { error: "Access denied: path is outside project root" }, 403);
					return;
				}
				slug = deriveAnnotateHistorySlug(resolved.path);
				if (getVersionCount(annotateProjectName, slug) === 0) {
					json(res, { error: "No version history" }, 404);
					return;
				}
			} else {
				if (!annotateHistory) {
					json(res, { error: "No version history" }, 404);
					return;
				}
				slug = annotateHistory.slug;
			}
			const vParam = url.searchParams.get("v");
			const v = vParam ? parseInt(vParam, 10) : NaN;
			if (isNaN(v) || v < 1) {
				json(res, { error: "Invalid version number" }, 400);
				return;
			}
			const content = getPlanVersion(annotateProjectName, slug, v);
			if (content === null) {
				json(res, { error: "Version not found" }, 404);
				return;
			}
			json(res, { plan: content, version: v });
		} else if (url.pathname === "/api/plan/versions" && req.method === "GET") {
			// list all stored versions of the annotated file (Version Browser)
			// Same `?path=`/`&base=` parameterization as /api/plan/version above.
			const pathParam = url.searchParams.get("path");
			if (pathParam !== null) {
				const resolved = resolveAllowedDocPath(pathParam, url.searchParams.get("base"), {
					rootPaths: getReferenceRootPaths(),
				});
				if (resolved.kind === "denied") {
					json(res, { error: "Access denied: path is outside project root" }, 403);
					return;
				}
				const slug = deriveAnnotateHistorySlug(resolved.path);
				const versions = listVersions(annotateProjectName, slug);
				json(res, {
					project: annotateProjectName,
					slug: versions.length > 0 ? slug : null,
					versions,
				});
				return;
			}
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
				const body = (await parseBody(req)) as { displayName?: string; diffOptions?: Record<string, unknown>; theme?: Record<string, unknown>; conventionalComments?: boolean };
				const toSave: Record<string, unknown> = {};
				if (body.displayName !== undefined) toSave.displayName = body.displayName;
				if (body.diffOptions !== undefined) toSave.diffOptions = body.diffOptions;
				if (body.theme !== undefined) toSave.theme = body.theme;
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
				annotateHistory:
					options.mode === "annotate-folder" && annotateHistoryEnabled
						? { compute: computeFolderAnnotateHistory }
						: undefined,
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
		} else if (url.pathname === "/api/skills" && req.method === "GET") {
			handleReferenceSkillsRequest(res);
		} else if (url.pathname === "/api/skills/content" && req.method === "GET") {
			handleReferenceSkillContentRequest(res, url);
		} else if (url.pathname === "/api/reference/obsidian/files" && req.method === "GET") {
			handleObsidianFilesRequest(res, url);
		} else if (url.pathname === "/api/reference/obsidian/doc" && req.method === "GET") {
			handleObsidianDocRequest(res, url);
		} else if (url.pathname === "/api/reference/files" && req.method === "GET") {
			await handleFileBrowserRequest(res, url);
		} else if (url.pathname === "/api/reference/files/stream" && req.method === "GET") {
			handleFileBrowserStreamRequest(req, res, url);
			return;
		} else if (url.pathname === "/favicon.png") {
			handleFavicon(res);
		} else if (url.pathname === "/api/exit" && req.method === "POST") {
			if (!decision.settle({ feedback: "", annotations: [], exit: true })) {
				sendAlreadyDecided(res);
				return;
			}
			deleteDraft(draftKey, readDraftGenerationFromUrl(req));
			clientLease.cancel();
			json(res, { ok: true });
		} else if (url.pathname === "/api/approve" && req.method === "POST") {
			try {
				const body = await parseOptionalApprovalBody(req);
				if (
					(body.feedback !== undefined && typeof body.feedback !== "string") ||
					(body.annotations !== undefined && !Array.isArray(body.annotations)) ||
					(body.codeAnnotations !== undefined && !Array.isArray(body.codeAnnotations)) ||
					(body.draftGeneration !== undefined && typeof body.draftGeneration !== "number")
				) {
					json(res, { error: "Invalid approval body." }, 400);
					return;
				}

				const approvalWon = decision.settle({
					feedback: (body.feedback as string | undefined) || "",
					annotations: (body.annotations as unknown[] | undefined) || [],
					approved: true,
					// Approval notes carry the same message scoping as /api/feedback —
					// without it, approve-with-notes in a multi-message annotate-last
					// session anchors to the last message instead of the one the
					// reviewer picked.
					selectedMessageId: typeof body.selectedMessageId === "string" ? body.selectedMessageId : undefined,
					feedbackScope: body.feedbackScope === "messages" ? "messages" : body.feedbackScope === "message" ? "message" : undefined,
				});
				if (!approvalWon) {
					sendAlreadyDecided(res);
					return;
				}
				// Approve-with-notes carries user content — make it durable before
				// the draft (the reviewer's only other copy) is deleted (#678).
				const approvalDurable = persistSubmittedDecision(
					(body.feedback as string | undefined) || "",
					(body.annotations as unknown[] | undefined) || [],
					true,
				);
				if (approvalDurable) deleteDraft(draftKey, readDraftGenerationFromBody(body));
				clientLease.cancel();
				json(res, { ok: true });
			} catch (err) {
				json(res, { error: err instanceof Error ? err.message : "Invalid JSON body." }, 400);
			}
		} else if (url.pathname === "/api/feedback" && req.method === "POST") {
			try {
				const body = await parseBody(req);
				const feedbackWon = decision.settle({
					feedback: (body.feedback as string) || "",
					annotations: (body.annotations as unknown[]) || [],
					selectedMessageId: typeof body.selectedMessageId === "string" ? body.selectedMessageId : undefined,
					feedbackScope: body.feedbackScope === "messages" ? "messages" : body.feedbackScope === "message" ? "message" : undefined,
				});
				if (!feedbackWon) {
					sendAlreadyDecided(res);
					return;
				}
				// Make the submitted feedback durable BEFORE deleting the draft:
				// the decision promise's consumer may have timed out, and this
				// record is then the only surviving copy (#678).
				const feedbackDurable = persistSubmittedDecision(
					(body.feedback as string) || "",
					(body.annotations as unknown[]) || [],
					false,
				);
				if (feedbackDurable) deleteDraft(draftKey, readDraftGenerationFromBody(body));
				clientLease.cancel();
				json(res, { ok: true });
			} catch (err) {
				const message = err instanceof Error ? err.message : "Failed to process feedback";
				json(res, { error: message }, 500);
			}
		} else if (url.pathname === "/api/save-notes" && req.method === "POST") {
			await handleSaveNotesRequest(req, res);
		} else if (url.pathname.startsWith("/api/")) {
			handleApiNotFound(res, url.pathname);
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
		url: buildAdvertisedUrl(port),
		waitForDecision: () => decisionPromise,
		stop: () => {
			// try/finally: a throwing dispose must never leave the listener bound.
			try {
				clientLease.cancel();
				// Long-lived host process: an unclosed lease stream would keep its
				// heartbeat timer and socket alive past the session, and would keep
				// server.close() from ever completing.
				clientLease.closeSessions();
				aiRuntime?.dispose();
				agentTerminal.dispose();
			} finally {
				server.close();
				// close() only stops the listener; drain browser keep-alive sockets so a
				// stopped session's connections die immediately instead of at the
				// browser's whim (parity with Bun's server.stop(), which closes idle
				// connections). Guarded: jiti can run under hosts whose node:http lacks
				// closeAllConnections.
				server.closeAllConnections?.();
			}
		},
	};
}
