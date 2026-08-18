/**
 * Annotate Server
 *
 * Provides a server for annotating arbitrary files, URLs, and folders.
 * Follows the same patterns as the review server but serves
 * annotation-session content via /api/plan so the plan editor UI can
 * render it without separate app bundles.
 *
 * Environment variables:
 *   PLANNOTATOR_REMOTE - Set to "1"/"true" for remote, "0"/"false" for local
 *   PLANNOTATOR_PORT   - Fixed port or inclusive range (default: random locally, 19432 for remote)
 */

import { isRemoteSession, getServerHostname, startBunServerOnAvailablePort, buildAdvertisedUrl } from "./remote";
import { getRepoInfo } from "./repo";
import type { Origin } from "@plannotator/shared/agents";
import { handleImage, handleUpload, handleServerReady, handleDraftSave, handleDraftLoad, handleDraftDelete, handleApiNotFound, handleFavicon, handleReferenceSkills, handleReferenceSkillContent, handleSaveNotes, readDraftGenerationFromBody, readDraftGenerationFromUrl } from "./shared-handlers";
import { handleDoc, handleDocExists, handleFileBrowserFiles, handleObsidianVaults, handleObsidianFiles, handleObsidianDoc, resolveAllowedDocPath, type FolderAnnotateHistory } from "./reference-handlers";
import { closeAllFileBrowserWatchers, handleFileBrowserFilesStream } from "./reference-watch";
import { getExtraMarkdownExtensions, resolveUserPath, warmFileListCache } from "@plannotator/shared/resolve-file";
import { contentHash, deleteDraft } from "./draft";
import { getPlanVersion, getVersionCount, listVersions } from "@plannotator/shared/storage";
import { computeAnnotateHistory, deriveAnnotateHistorySlug, persistAnnotateSubmission, type AnnotateHistoryResult } from "@plannotator/shared/annotate-history";
import { htmlDiff } from "@plannotator/shared/html-diff";
import { disabledSourceSave, type SourceSaveRequest } from "@plannotator/shared/source-save";
import { getAnnotateReferenceRootPaths } from "@plannotator/shared/annotate-reference-roots-node";
import { getAnnotateFileFeedbackTemplate, getAnnotateMessageFeedbackTemplate } from "@plannotator/shared/prompts";
import {
	createSourceSaveCapability,
	createSourceSaveCapabilityFromText,
	readSourceFileSnapshot,
	resolveFolderSourceFile,
	resolveFolderSourceFileForSave,
	saveSourceFileAtomic,
} from "@plannotator/shared/source-save-node";
import { createExternalAnnotationHandler } from "./external-annotations";
import {
  ANNOTATE_CLIENT_LEASE_GRACE_MS,
  ANNOTATE_CLIENT_LEASE_HEARTBEAT_MS,
  ANNOTATE_CLIENT_LEASE_STREAM_PATH,
  createAnnotateClientLeaseStreamSession,
  createAnnotateClientLeaseTracker,
  type AnnotateClientLeaseStreamSession,
} from "@plannotator/shared/annotate-client-lease";
import { createAnnotateDecisionSettler } from "@plannotator/shared/annotate-decision";
import { saveConfig, detectGitUser, getServerConfig, loadConfig, resolveAIEnabled, resolveAnnotateHistory } from "./config";
import { isFaviconStyle, type FaviconStyle } from "@plannotator/shared/favicon";
import { existsSync } from "fs";
import { dirname, resolve as resolvePath } from "path";
import { isWithinDirectory } from "@plannotator/shared/html-assets-node";
import { isWSL } from "./browser";
import { handleOpenInApps, handleOpenIn } from "./open-in";
import { AI_QUERY_ENDPOINT, createAIRuntime } from "./ai-runtime";
import { isAIEndpointPath, type AIEndpoints } from "@plannotator/ai";
import { createHtmlAssetRegistry } from "./html-assets";
import { createBunAgentTerminalBridge } from "./agent-terminal";
import { isAgentTerminalWsRoute, supportsAnnotateAgentTerminalMode } from "@plannotator/shared/agent-terminal";

// Re-export utilities
export { isRemoteSession, getServerPort } from "./remote";
export { openBrowser } from "./browser";
export { handleServerReady as handleAnnotateServerReady } from "./shared-handlers";

// --- Types ---

export interface AnnotateServerOptions {
  /** Markdown content of the file to annotate. Empty when rendering raw HTML. */
  markdown: string;
  /** Original file path (for display purposes) */
  filePath: string;
  /** HTML content to serve for the UI */
  htmlContent: string;
  /** Origin identifier for UI customization */
  origin?: Origin;
  /** UI mode: "annotate" for files, "annotate-last" for last agent message, "annotate-folder" for folders */
  mode?: "annotate" | "annotate-last" | "annotate-folder";
  /** Folder path when annotating a directory (used as projectRoot for file browser) */
  folderPath?: string;
  /**
   * Recent assistant messages for `annotate-last` mode (newest-first). When
   * provided with more than one entry, the editor renders a picker so users
   * can choose which message to annotate; index 0 is the default selection
   * and matches the legacy "last message" behavior.
   */
  recentMessages?: { messageId: string; text: string; timestamp?: string }[];
  /** Whether URL sharing is enabled (default: true) */
  sharingEnabled?: boolean;
  /** Custom base URL for share links */
  shareBaseUrl?: string;
  /** Base URL of the paste service API for short URL sharing */
  pasteApiUrl?: string;
  /** Source attribution: original URL or filename (e.g. "https://..." or "index.html") */
  sourceInfo?: string;
  /** True when `markdown` was produced by Turndown/Jina (HTML or URL) —
   *  feedback line numbers won't match the original source. */
  sourceConverted?: boolean;
  /** Enable review-gate UX: adds an Approve button alongside Close/Send Annotations */
  gate?: boolean;
  /** Whether this transport can deliver feedback attached to an approval. */
  approvalNotesSupported?: boolean;
  /**
   * Whether this transport can safely resolve an abandoned gate automatically.
   * Only local direct structured annotate gates (`--gate --json`, not `--hook`,
   * not remote/shared) qualify — see supportsAnnotateClientLease in
   * apps/hook/server/annotate-output.ts. The server additionally forces this
   * off while `tailnetPublished` is set: `--tailscale` counts as local to the
   * CLI predicate, but the session is reached through the serve proxy, whose
   * disconnects would read as abandonment exactly like a remote tunnel's.
   */
  clientLeaseSupported?: boolean;
  /**
   * @internal Test-only timing overrides for the client-lease grace/heartbeat
   * period. Production always uses the real 30s/5s defaults; tests inject
   * short values so they don't have to sleep for the real grace period.
   */
  clientLeaseTestOverrides?: { graceMs?: number; heartbeatMs?: number };
  /** Raw HTML content for direct iframe rendering. */
  rawHtml?: string;
  /** Render HTML as-is in an iframe. */
  renderHtml?: boolean;
  /** Session-level force-markdown preference (`--markdown`). Exposed in /api/plan so the
   *  frontend appends `&convert=1` when navigating folder/linked HTML files. */
  convertHtml?: boolean;
  /** CWD where the optional annotate agent terminal should launch. Defaults to process.cwd(). */
  agentCwd?: string;
  /**
   * The session is loopback-bound but published across the user's tailnet
   * (--tailscale). Gates the agent terminal behind the same
   * PLANNOTATOR_AGENT_TERMINAL_REMOTE opt-in remote mode uses: the PTY token
   * is not an auth boundary against network peers (wsPath ships in the
   * /api/plan capability payload), so tailnet reachability implies terminal
   * reachability.
   */
  tailnetPublished?: boolean;
  /** Project name for keying per-file version history (powers the annotate version diff). */
  project?: string;
  /** Called when server starts with the URL, remote status, and port */
  onReady?: (url: string, isRemote: boolean, port: number) => void | Promise<void>;
}

export interface AnnotateServerResult {
  /** The port the server is running on */
  port: number;
  /** The full URL to access the server */
  url: string;
  /** Whether running in remote mode */
  isRemote: boolean;
  /** Wait for user feedback submission */
  waitForDecision: () => Promise<{
    feedback: string;
    annotations: unknown[];
    exit?: boolean;
    approved?: boolean;
    selectedMessageId?: string;
    feedbackScope?: "message" | "messages";
  }>;
  /** Stop the server */
  stop: () => void;
}

// --- Server Implementation ---

/**
 * Start the Annotate server
 *
 * Handles:
 * - Remote detection and port configuration
 * - API routes (/api/plan with mode:"annotate", /api/feedback)
 * - Port conflict retries
 */
export async function startAnnotateServer(
  options: AnnotateServerOptions
): Promise<AnnotateServerResult> {
  const {
    markdown,
    filePath,
    htmlContent,
    origin,
    mode = "annotate",
    folderPath,
    recentMessages,
    sourceInfo,
    sourceConverted,
    sharingEnabled = true,
    shareBaseUrl,
    pasteApiUrl,
    gate = false,
    approvalNotesSupported = false,
    clientLeaseTestOverrides,
    rawHtml,
    renderHtml = false,
    convertHtml = false,
    agentCwd,
    project,
    onReady,
  } = options;

  // Effective client-lease capability. A --tailscale session forces local
  // mode, so the CLI-side supportsAnnotateClientLease predicate reads it as
  // local — but every client reaches it through the tailscale serve proxy,
  // and a proxy/network disconnect longer than the grace period would
  // auto-dismiss a live review. Same rationale that keeps the capability off
  // for remote/shared sessions; this is the single decision point both the
  // /api/plan advert and the SSE endpoint below read.
  const clientLeaseSupported =
    (options.clientLeaseSupported ?? false) && options.tailnetPublished !== true;

  const isRemote = isRemoteSession();
  const wslFlag = await isWSL();
  const gitUser = detectGitUser();

  // Per-file version history → powers the native version diff in annotate mode.
  // Unlike the plan flow (slug = first-heading + date), annotate keys history by
  // file path so re-opening the same file groups its versions across edits even
  // when headings change. Diff content is the markdown, or the raw HTML source
  // when rendering HTML. Only single local files (not URLs/folders/messages).
  const annotateProjectName = project ?? "_unknown";
  const annotateHistoryEnabled = resolveAnnotateHistory(loadConfig());
  // Single local file sessions are the only ones this eager gate covers.
  // URL and agent-message sessions never write session content to the data
  // dir. Folder sessions do participate in per-file version history, but
  // lazily through /api/doc (see computeFolderAnnotateHistory below), not
  // here. The durable submit records stay single-local-file only.
  const singleFileLocalAnnotate = mode === "annotate" && !/^https?:\/\//i.test(filePath);
  let annotateHistory: AnnotateHistoryResult | null = null;
  {
    const historyContent = renderHtml && rawHtml ? rawHtml : markdown;
    const eligible =
      singleFileLocalAnnotate &&
      historyContent.length > 0 &&
      annotateHistoryEnabled;
    // History is an enhancement, never a gate: a read-only/full data dir
    // must degrade to v0.22.0's stateless annotate (no version diff), not
    // fail the whole session before the UI ever opens. (computeAnnotateHistory
    // never throws — it logs and returns null on any storage error.)
    if (eligible) {
      annotateHistory = computeAnnotateHistory(annotateProjectName, resolvePath(filePath), historyContent);
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
  const draftSource =
    mode === "annotate-folder" && folderPath
      ? `folder:${resolvePath(folderPath)}`
      : renderHtml && rawHtml ? rawHtml : markdown;
  const draftKey = contentHash(draftSource);

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
  // only. annotate-last / URL / folder sessions never wrote submit
  // records and still do not: their submissions quote agent messages or
  // fetched pages, which this record was never meant to persist. (Folder
  // sessions do write lazy per-file version history via /api/doc; that is
  // a separate, documented pipeline with its own gate.)
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
        sessionPath: resolvePath(filePath),
        feedback: feedbackText,
        annotations: annotationList,
        approved,
      }) !== null
    );
  };
  const externalAnnotations = createExternalAnnotationHandler("plan");
  const aiRuntime = resolveAIEnabled() ? await createAIRuntime() : null;
  const htmlAssets = createHtmlAssetRegistry();
  const agentTerminal = await createBunAgentTerminalBridge({
    enabled: supportsAnnotateAgentTerminalMode(mode),
    cwd: agentCwd ?? process.cwd(),
    tailnetPublished: options.tailnetPublished === true,
  });

  async function loadShareHtml(pathParam: string | null): Promise<Response> {
    if (/^https?:\/\//i.test(filePath)) {
      return Response.json({ error: "Raw HTML sharing is unavailable for URL annotations" }, { status: 400 });
    }

    const sourcePath = resolvePath(filePath);
    const requestedPath = pathParam ? resolvePath(pathParam) : sourcePath;
    if (!/\.html?$/i.test(requestedPath)) {
      return Response.json({ error: "Share HTML is only available for HTML documents" }, { status: 400 });
    }
    if (!isAllowedHtmlSharePath(requestedPath)) {
      return Response.json({ error: "Access denied" }, { status: 403 });
    }

    try {
      const html = renderHtml && rawHtml && requestedPath === sourcePath
        ? rawHtml
        : await Bun.file(requestedPath).text();
      return Response.json({ shareHtml: htmlAssets.inlineHtml(html, requestedPath) });
    } catch {
      return Response.json({ error: "Failed to prepare share HTML" }, { status: 500 });
    }
  }

  function isAllowedHtmlSharePath(targetPath: string): boolean {
    const roots = new Set<string>([process.cwd()]);
    if (folderPath) roots.add(folderPath);
    if (!/^https?:\/\//i.test(filePath)) roots.add(dirname(filePath));
    for (const root of roots) {
      if (isWithinDirectory(targetPath, root)) return true;
    }
    return false;
  }

  const singleFileSourceSaveEligible = mode === "annotate" && !sourceConverted && !(renderHtml && rawHtml) && !/^https?:\/\//i.test(filePath);
  const initialSingleFileSourceSave = singleFileSourceSaveEligible
    ? createSourceSaveCapability("single-file", filePath)
    : null;
  const initialSingleFileSourcePath = singleFileSourceSaveEligible
    ? initialSingleFileSourceSave?.enabled
      ? initialSingleFileSourceSave.path
      : resolveUserPath(filePath)
    : null;
  const openedSourceFilePaths = new Set<string>();
  if (initialSingleFileSourcePath) openedSourceFilePaths.add(initialSingleFileSourcePath);
  const getPrimarySource = () => {
    if (mode === "annotate-last") {
      return { plan: markdown, sourceSave: disabledSourceSave("message-mode") };
    }
    if (mode === "annotate-folder") {
      return { plan: markdown, sourceSave: disabledSourceSave("folder-mode") };
    }
    if (renderHtml && rawHtml) {
      return { plan: markdown, sourceSave: disabledSourceSave("html-render") };
    }
    if (sourceConverted) {
      return { plan: markdown, sourceSave: disabledSourceSave("converted-source") };
    }
    if (/^https?:\/\//i.test(filePath)) {
      return { plan: markdown, sourceSave: disabledSourceSave("not-local-file") };
    }

    const sourceSave = createSourceSaveCapability("single-file", initialSingleFileSourcePath ?? filePath);
    if (!sourceSave.enabled) {
      if (sourceSave.reason === "missing-file" && initialSingleFileSourcePath) {
        const missingSourceSave = createSourceSaveCapabilityFromText("single-file", initialSingleFileSourcePath, markdown);
        if (missingSourceSave.enabled) {
          return { plan: markdown, sourceSave: missingSourceSave };
        }
      }
      return { plan: markdown, sourceSave };
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
      return { plan: markdown, sourceSave: disabledSourceSave("unreadable-file") };
    }
  };

  const getReferenceRootPaths = () => getAnnotateReferenceRootPaths({
    mode,
    filePath,
    folderPath,
    initialSingleFileSourcePath,
  });

  // Detect repo info (cached for this session)
  const repoInfo = await getRepoInfo();

  // Decision promise
  let resolveDecision: (result: {
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
  }>((resolve) => {
    resolveDecision = resolve;
  });

  // Every decision producer goes through this: connected tabs and the client
  // lease below race, and a producer that loses must not delete the reviewer's
  // draft or report success for an outcome the caller never received.
  const decision = createAnnotateDecisionSettler(resolveDecision!);
  const alreadyDecided = () =>
    Response.json({ error: "This review session has already been decided." }, { status: 409 });

  // Last-client abandonment lease: once the tab's client-lease stream
  // disconnects (as reported by the transport) and stays disconnected for the
  // grace period with no reconnect, the decision resolves as dismissed
  // instead of hanging the CLI/hook caller forever. Only meaningful once at
  // least one client connects. Grace timing is bounded only for clean
  // disconnects; abrupt/half-open connection loss is detected on a
  // best-effort basis by the transport (e.g. a failing heartbeat write) and
  // can take longer than graceMs to be noticed at all — see
  // packages/shared/annotate-client-lease.ts.
  const clientLeaseGraceMs = clientLeaseTestOverrides?.graceMs ?? ANNOTATE_CLIENT_LEASE_GRACE_MS;
  const clientLeaseHeartbeatMs = clientLeaseTestOverrides?.heartbeatMs ?? ANNOTATE_CLIENT_LEASE_HEARTBEAT_MS;
  const clientLease = createAnnotateClientLeaseTracker(
    () => decision.settle({ feedback: "", annotations: [], exit: true }),
    { graceMs: clientLeaseGraceMs },
  );

  const server = await startBunServerOnAvailablePort((port) =>
    Bun.serve({
        hostname: getServerHostname(),
        port,
        // Bun's default 10s idleTimeout kills AI SSE streams that stall
        // between bytes (e.g. while a permission prompt waits on the user).
        idleTimeout: 0,

        async fetch(req, server) {
          const url = new URL(req.url);

          if (agentTerminal.matches(url.pathname)) {
            if (agentTerminal.capability.enabled && agentTerminal.upgrade(req, server)) {
              return;
            }
            return new Response("Agent terminal is unavailable", { status: 404 });
          }
          if (isAgentTerminalWsRoute(url.pathname)) {
            return new Response("Agent terminal is unavailable", { status: 404 });
          }

          // API: Get plan content (reuse /api/plan so the plan editor UI works)
          if (url.pathname === "/api/plan" && req.method === "GET") {
            const displayRawHtml = renderHtml && rawHtml ? htmlAssets.rewriteHtml(rawHtml, filePath) : undefined;
            // For HTML, render the version diff as the real page with inline
            // <ins>/<del> highlights (tag-aware htmlDiff), asset-rewritten the
            // same way as the live page so it renders identically.
            const diffHtml =
              renderHtml && rawHtml && annotateHistory?.previousPlan
                ? htmlAssets.rewriteHtml(htmlDiff(annotateHistory.previousPlan, rawHtml), filePath)
                : undefined;
            const primarySource = getPrimarySource();
            return Response.json({
              plan: primarySource.plan,
              origin,
              mode,
              filePath,
              sourceInfo,
              sourceConverted: sourceConverted ?? false,
              sourceSave: primarySource.sourceSave,
              gate,
              approvalNotesSupported,
              clientLease: clientLeaseSupported
                ? { enabled: true as const, reconnectGraceMs: clientLeaseGraceMs }
                : { enabled: false as const },
              renderAs: displayRawHtml ? 'html' as const : 'markdown' as const,
              ...(displayRawHtml ? { rawHtml: displayRawHtml } : {}),
              ...(diffHtml ? { diffHtml } : {}),
              convertHtml,
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
              projectRoot: folderPath || process.cwd(),
              isWSL: wslFlag,
              // Extra extensions the user registered as markdown (#1307).
              // The renderer needs them to linkify relative/wiki links to
              // sibling docs the same way it linkifies .md ones.
              markdownExtensions: getExtraMarkdownExtensions(),
              serverConfig: getServerConfig(gitUser),
              agentTerminal: agentTerminal.capability,
              ...(recentMessages ? { recentMessages } : {}),
              // Resolved copy-wrapper templates (config-aware, placeholders
              // intact) so clipboard Copy matches what Send Feedback produces
              // instead of the plan-deny wrap (#1107). Resolved per request so
              // config edits mid-session behave like Send Feedback (which
              // resolves at submit time).
              feedbackTemplates: {
                fileFeedback: getAnnotateFileFeedbackTemplate(origin),
                messageFeedback: getAnnotateMessageFeedbackTemplate(origin),
              },
            });
          }

          // API: fetch a specific version of the annotated file (version diff base picker)
          //
          // Folder sessions pass `?path=` (optionally `&base=`) to identify which
          // file's history to read, resolved and containment-checked exactly like
          // /api/doc; the slug is always derived server-side from that resolved
          // path — a client-supplied slug is never accepted, since getHistoryDir
          // joins it into a filesystem path unsanitized. Without `path`, behavior
          // is unchanged: the single session's own history is used.
          if (url.pathname === "/api/plan/version" && req.method === "GET") {
            const pathParam = url.searchParams.get("path");
            let slug: string;
            if (pathParam !== null) {
              const resolved = resolveAllowedDocPath(pathParam, url.searchParams.get("base"), {
                rootPaths: getReferenceRootPaths(),
              });
              if (resolved.kind === "denied") {
                return Response.json({ error: "Access denied: path is outside project root" }, { status: 403 });
              }
              slug = deriveAnnotateHistorySlug(resolved.path);
              if (getVersionCount(annotateProjectName, slug) === 0) {
                return Response.json({ error: "No version history" }, { status: 404 });
              }
            } else {
              if (!annotateHistory) {
                return Response.json({ error: "No version history" }, { status: 404 });
              }
              slug = annotateHistory.slug;
            }
            const vParam = url.searchParams.get("v");
            const v = vParam ? parseInt(vParam, 10) : NaN;
            if (isNaN(v) || v < 1) {
              return new Response("Invalid version number", { status: 400 });
            }
            const content = getPlanVersion(annotateProjectName, slug, v);
            if (content === null) {
              return Response.json({ error: "Version not found" }, { status: 404 });
            }
            return Response.json({ plan: content, version: v });
          }

          // API: list all stored versions of the annotated file (Version Browser)
          // Same `?path=`/`&base=` parameterization as /api/plan/version above.
          if (url.pathname === "/api/plan/versions" && req.method === "GET") {
            const pathParam = url.searchParams.get("path");
            if (pathParam !== null) {
              const resolved = resolveAllowedDocPath(pathParam, url.searchParams.get("base"), {
                rootPaths: getReferenceRootPaths(),
              });
              if (resolved.kind === "denied") {
                return Response.json({ error: "Access denied: path is outside project root" }, { status: 403 });
              }
              const slug = deriveAnnotateHistorySlug(resolved.path);
              const versions = listVersions(annotateProjectName, slug);
              return Response.json({
                project: annotateProjectName,
                slug: versions.length > 0 ? slug : null,
                versions,
              });
            }
            if (!annotateHistory) {
              return Response.json({ project: annotateProjectName, slug: null, versions: [] });
            }
            return Response.json({
              project: annotateProjectName,
              slug: annotateHistory.slug,
              versions: listVersions(annotateProjectName, annotateHistory.slug),
            });
          }

          if (url.pathname === "/api/share-html" && req.method === "GET") {
            return loadShareHtml(url.searchParams.get("path"));
          }

          // API: List apps the host can open a file in (Open in App control).
          if (url.pathname === "/api/open-in/apps" && req.method === "GET") {
            // A URL annotation source has no local file to open — mirror Pi and
            // report unavailable so the UI hides the control entirely.
            if (/^https?:\/\//i.test(filePath)) {
              return Response.json({ available: false, apps: [] });
            }
            return handleOpenInApps();
          }

          // API: Open the annotated file in an app. A URL source has no local
          // file; any other open is confined to the same reference roots
          // /api/doc serves from, so any linked doc the user can view can also
          // be opened — and nothing outside the session can.
          if (url.pathname === "/api/open-in" && req.method === "POST") {
            if (/^https?:\/\//i.test(filePath)) {
              return Response.json(
                { ok: false, error: "Open in app is unavailable for this source" },
                { status: 400 },
              );
            }
            return handleOpenIn(req, { resolveRoot: getReferenceRootPaths });
          }

          // API: Update user config (write-back to ~/.plannotator/config.json)
          if (url.pathname === "/api/config" && req.method === "POST") {
            try {
              const body = (await req.json()) as { displayName?: string; diffOptions?: Record<string, unknown>; theme?: Record<string, unknown>; favicon?: FaviconStyle; conventionalComments?: boolean; conventionalLabels?: unknown[] | null };
              const toSave: Record<string, unknown> = {};
              if (body.displayName !== undefined) toSave.displayName = body.displayName;
              if (body.diffOptions !== undefined) toSave.diffOptions = body.diffOptions;
              if (body.theme !== undefined) toSave.theme = body.theme;
              if (isFaviconStyle(body.favicon)) toSave.favicon = body.favicon;
              if (body.conventionalComments !== undefined) toSave.conventionalComments = body.conventionalComments;
              if (body.conventionalLabels !== undefined) toSave.conventionalLabels = body.conventionalLabels;
              if (Object.keys(toSave).length > 0) saveConfig(toSave as Parameters<typeof saveConfig>[0]);
              return Response.json({ ok: true });
            } catch {
              return Response.json({ error: "Invalid request" }, { status: 400 });
            }
          }

          // API: Serve images (local paths or temp uploads)
          if (url.pathname === "/api/image") {
            return handleImage(req);
          }

          const htmlAssetResponse = await htmlAssets.handle(req, url);
          if (htmlAssetResponse) {
            return htmlAssetResponse;
          }

          // API: Serve a linked markdown document. The annotate session owns the
          // source-file base and --markdown preference, so enforce both here.
          if (url.pathname === "/api/doc" && req.method === "GET") {
            const docUrl = new URL(req.url);
            let changed = false;
            if (!docUrl.searchParams.has("base") && !/^https?:\/\//i.test(filePath)) {
              docUrl.searchParams.set("base", mode === "annotate-folder" && folderPath ? folderPath : dirname(filePath));
              changed = true;
            }
            if (convertHtml && !docUrl.searchParams.has("convert")) {
              docUrl.searchParams.set("convert", "1");
              changed = true;
            }
            const docReq = changed ? new Request(docUrl.toString()) : req;
            return handleDoc(docReq, {
              rewriteHtml: htmlAssets.rewriteHtml,
              sourceSaveFilePath: singleFileSourceSaveEligible
                ? initialSingleFileSourcePath ?? filePath
                : undefined,
              sourceSaveFolderPath: mode === "annotate-folder" ? folderPath : undefined,
              onSourceDocumentServed: (path) => openedSourceFilePaths.add(path),
              rootPaths: getReferenceRootPaths(),
              annotateHistory:
                mode === "annotate-folder" && annotateHistoryEnabled
                  ? { compute: computeFolderAnnotateHistory }
                  : undefined,
            });
          }

          if (url.pathname === "/api/source/save" && req.method === "POST") {
            let body: SourceSaveRequest;
            try {
              body = (await req.json()) as SourceSaveRequest;
            } catch {
              return Response.json(
                { ok: false, code: "invalid-request", message: "Invalid JSON body." },
                { status: 400 },
              );
            }

            if (typeof body.text !== "string" || typeof body.baseHash !== "string") {
              return Response.json(
                { ok: false, code: "invalid-request", message: "Expected text and baseHash." },
                { status: 400 },
              );
            }

            let targetPath: string | null = null;
            if (singleFileSourceSaveEligible) {
              const capability = createSourceSaveCapability("single-file", initialSingleFileSourcePath ?? filePath);
              targetPath = capability.enabled ? capability.path : initialSingleFileSourcePath;
            } else if (mode === "annotate-folder" && folderPath && typeof body.path === "string") {
              targetPath = body.allowMissingBase
                ? resolveFolderSourceFileForSave(body.path, folderPath)
                : resolveFolderSourceFile(body.path, folderPath);
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
              return Response.json(
                { ok: false, code: "not-writable", message: "This document cannot be saved to a file." },
                { status: 403 },
              );
            }

            const result = saveSourceFileAtomic(targetPath, body.text, body.baseHash, {
              allowMissingBase: body.allowMissingBase === true,
              missingBaseEol: body.baseEol,
              allowedRoot: mode === "annotate-folder" ? folderPath : undefined,
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
            return Response.json(result, { status });
          }

          // API: Batch existence check for code-file paths the renderer detected
          if (url.pathname === "/api/doc/exists" && req.method === "POST") {
            return handleDocExists(req, { rootPaths: getReferenceRootPaths() });
          }

          // API: Detect Obsidian vaults
          if (url.pathname === "/api/obsidian/vaults") {
            return handleObsidianVaults();
          }

          // API: Global skill catalog for comment skill references
          if (url.pathname === "/api/skills" && req.method === "GET") {
            return handleReferenceSkills();
          }

          // API: SKILL.md contents for a referenced human-only skill
          if (url.pathname === "/api/skills/content" && req.method === "GET") {
            return handleReferenceSkillContent(req);
          }

          // API: List Obsidian vault files as a tree
          if (url.pathname === "/api/reference/obsidian/files" && req.method === "GET") {
            return handleObsidianFiles(req);
          }

          // API: Read an Obsidian vault document
          if (url.pathname === "/api/reference/obsidian/doc" && req.method === "GET") {
            return handleObsidianDoc(req);
          }

          // API: List markdown files in a directory as a tree
          if (url.pathname === "/api/reference/files" && req.method === "GET") {
            return handleFileBrowserFiles(req);
          }

          // API: Watch file browser roots and refresh the tree/status snapshot on changes
          if (url.pathname === "/api/reference/files/stream" && req.method === "GET") {
            return handleFileBrowserFilesStream(req, {
              disableIdleTimeout: () => server.timeout(req, 0),
            });
          }

          // API: Upload image -> save to temp -> return path
          if (url.pathname === "/api/upload" && req.method === "POST") {
            return handleUpload(req);
          }

          // API: Annotation draft persistence
          if (url.pathname === "/api/draft") {
            if (req.method === "POST") return handleDraftSave(req, draftKey);
            if (req.method === "DELETE") return handleDraftDelete(draftKey, req);
            return handleDraftLoad(draftKey);
          }

          // API: Client-lease SSE — see packages/shared/annotate-client-lease.ts.
          // Only local direct structured annotate gates (--gate --json) advertise
          // and serve this; other transports get a 404 (idleTimeout is already 0
          // for the whole server above, so no per-connection opt-out is needed).
          if (url.pathname === ANNOTATE_CLIENT_LEASE_STREAM_PATH && req.method === "GET") {
            if (!clientLeaseSupported) {
              return new Response("Client lease unavailable", { status: 404 });
            }

            const encoder = new TextEncoder();
            let session: AnnotateClientLeaseStreamSession | null = null;

            const stream = new ReadableStream({
              start(controller) {
                session = createAnnotateClientLeaseStreamSession({
                  tracker: clientLease,
                  heartbeatMs: clientLeaseHeartbeatMs,
                  write: (chunk) => controller.enqueue(encoder.encode(chunk)),
                  endStream: () => controller.close(),
                });
              },
              cancel() {
                session?.close();
              },
            });

            return new Response(stream, {
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
              },
            });
          }

          // API: External annotations (SSE-based, for any external tool)
          const externalResponse = await externalAnnotations.handle(req, url, {
            disableIdleTimeout: () => server.timeout(req, 0),
          });
          if (externalResponse) return externalResponse;

          if (url.pathname.startsWith("/api/ai/")) {
            if (!aiRuntime) {
              if (!isAIEndpointPath(url.pathname)) {
                return handleApiNotFound(url.pathname);
              }
              if (url.pathname.slice("/api/ai/".length) === "capabilities" && req.method === "GET") {
                return Response.json({ available: false, providers: [] });
              }
              return Response.json({ error: "AI backend not available" }, { status: 503 });
            }
            const handler = aiRuntime.endpoints[url.pathname as keyof AIEndpoints];
            if (handler) {
              if (url.pathname === AI_QUERY_ENDPOINT) {
                server.timeout(req, 0);
              }
              return handler(req);
            }
            return handleApiNotFound(url.pathname);
          }

          // API: Exit annotation session without feedback
          if (url.pathname === "/api/exit" && req.method === "POST") {
            if (!decision.settle({ feedback: "", annotations: [], exit: true })) {
              return alreadyDecided();
            }
            deleteDraft(draftKey, readDraftGenerationFromUrl(req));
            clientLease.cancel();
            return Response.json({ ok: true });
          }

          // API: Approve the annotation session (review-gate UX)
          if (url.pathname === "/api/approve" && req.method === "POST") {
            const rawBody = await req.text();
            let body: Record<string, unknown> = {};
            if (rawBody.trim()) {
              try {
                const parsed = JSON.parse(rawBody);
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                  throw new Error("Expected a JSON object.");
                }
                body = parsed as Record<string, unknown>;
              } catch (err) {
                return Response.json(
                  { error: err instanceof Error ? err.message : "Invalid JSON body." },
                  { status: 400 },
                );
              }
            }
            if (
              (body.feedback !== undefined && typeof body.feedback !== "string") ||
              (body.annotations !== undefined && !Array.isArray(body.annotations)) ||
              (body.codeAnnotations !== undefined && !Array.isArray(body.codeAnnotations)) ||
              (body.draftGeneration !== undefined && typeof body.draftGeneration !== "number")
            ) {
              return Response.json({ error: "Invalid approval body." }, { status: 400 });
            }

            const approvalWon = decision.settle({
              feedback: (body.feedback as string | undefined) || "",
              annotations: (body.annotations as unknown[] | undefined) || [],
              approved: true,
              // Approval notes carry the same message scoping as /api/feedback —
              // without it, approve-with-notes in a multi-message annotate-last
              // session anchors to the last message instead of the one the
              // reviewer picked.
              selectedMessageId:
                typeof body.selectedMessageId === "string" ? body.selectedMessageId : undefined,
              feedbackScope:
                body.feedbackScope === "messages"
                  ? "messages"
                  : body.feedbackScope === "message"
                    ? "message"
                    : undefined,
            });
            if (!approvalWon) return alreadyDecided();
            // Approve-with-notes carries user content — make it durable before
            // the draft (the reviewer's only other copy) is deleted (#678).
            const approvalDurable = persistSubmittedDecision(
              (body.feedback as string | undefined) || "",
              (body.annotations as unknown[] | undefined) || [],
              true,
            );
            if (approvalDurable) deleteDraft(draftKey, readDraftGenerationFromBody(body));
            clientLease.cancel();
            return Response.json({ ok: true });
          }

          // API: Submit annotation feedback
          if (url.pathname === "/api/feedback" && req.method === "POST") {
            try {
              const body = (await req.json()) as {
                feedback: string;
                annotations: unknown[];
                selectedMessageId?: string;
                feedbackScope?: "message" | "messages";
                draftGeneration?: number;
              };

              const feedbackWon = decision.settle({
                feedback: body.feedback || "",
                annotations: body.annotations || [],
                selectedMessageId: body.selectedMessageId,
                feedbackScope: body.feedbackScope,
              });
              if (!feedbackWon) return alreadyDecided();
              // Make the submitted feedback durable BEFORE deleting the draft:
              // the decision promise's consumer may have timed out, and this
              // record is then the only surviving copy (#678).
              const feedbackDurable = persistSubmittedDecision(
                body.feedback || "",
                body.annotations || [],
                false,
              );
              if (feedbackDurable) deleteDraft(draftKey, readDraftGenerationFromBody(body));
              clientLease.cancel();

              return Response.json({ ok: true });
            } catch (err) {
              const message =
                err instanceof Error
                  ? err.message
                  : "Failed to process feedback";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: Save notes to external integrations (Obsidian, Bear, Octarine)
          if (url.pathname === "/api/save-notes" && req.method === "POST") {
            return handleSaveNotes(req);
          }

          // Favicon
          if (url.pathname === "/favicon.png") return handleFavicon();

          // API 404 guard: unknown /api/* routes should return JSON, not HTML
          if (url.pathname.startsWith("/api/")) {
            return handleApiNotFound(url.pathname);
          }

          // Serve embedded HTML for all other routes (SPA)
          return new Response(htmlContent, {
            headers: { "Content-Type": "text/html" },
          });
        },
        websocket: agentTerminal.websocket,

        error(err) {
          console.error("[plannotator] Server error:", err);
          return new Response(
            `Internal Server Error: ${err instanceof Error ? err.message : String(err)}`,
            { status: 500, headers: { "Content-Type": "text/plain" } },
          );
        },
    }),
  );

  const port = server.port!;
  const serverUrl = buildAdvertisedUrl(port);

  // The cache warm must never gate the listening socket. Its async filesystem
  // walk yields between directories while requests remain serviceable.
  void warmFileListCache(process.cwd(), "code");

  const stop = () => {
    // try/finally: a throwing disposal must never leave the listener bound.
    try {
      closeAllFileBrowserWatchers();
      clientLease.cancel();
      clientLease.closeSessions();
      aiRuntime?.dispose();
      agentTerminal.dispose();
    } finally {
      server.stop();
    }
  };

  // Notify caller that server is ready. An async ready handler that rejects
  // (e.g. --tailscale publishing failed) must stop the server and propagate:
  // firing-and-forgetting it would leave an unhandled rejection while the
  // loopback server keeps listening and the session hangs forever.
  if (onReady) {
    try {
      await onReady(serverUrl, isRemote, port);
    } catch (error) {
      stop();
      throw error;
    }
  }

  return {
    port,
    url: serverUrl,
    isRemote,
    waitForDecision: () => decisionPromise,
    stop,
  };
}
