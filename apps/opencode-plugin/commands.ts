/**
 * Command Handlers for OpenCode Plugin
 *
 * Handles /plannotator-review, /plannotator-annotate, and /plannotator-last
 * slash commands. Extracted from the event hook for modularity.
 */

import {
  startReviewServer,
  handleReviewServerReady,
} from "@plannotator/server/review";
import {
  startAnnotateServer,
  handleAnnotateServerReady,
} from "@plannotator/server/annotate";
import { type DiffType, prepareLocalReviewDiff, detectManagedVcs } from "@plannotator/server/vcs";
import { detectProjectName } from "@plannotator/server/project";
import { parsePRUrl, checkPRAuth, fetchPR, getCliName, getMRLabel, getMRNumberLabel, getDisplayRepo } from "@plannotator/server/pr";
import { loadConfig, resolveDefaultDiffType, resolveUseJina } from "@plannotator/shared/config";
import {
  getAnnotateApprovedWithNotesPrompt,
  getReviewApprovedPrompt,
  getReviewDeniedSuffix,
  getAnnotateFileFeedbackPrompt,
} from "@plannotator/shared/prompts";
import { resolveMarkdownFile, resolveUserPath, hasMarkdownFiles, getAnnotatableDocRegex, MAX_ANNOTATABLE_FILE_BYTES } from "@plannotator/shared/resolve-file";
import { FILE_BROWSER_EXCLUDED } from "@plannotator/shared/reference-common";
import { htmlToMarkdown } from "@plannotator/shared/html-to-markdown";
import { parseAnnotateArgs } from "@plannotator/shared/annotate-args";
import {
  annotateInputNamesExistingTarget,
  buildAmbiguousAnnotateArgsMessage,
  buildUnresolvedAnnotateArgsMessage,
  probeAnnotateToken,
  selectAnnotateTokenTarget,
} from "@plannotator/shared/annotate-target";
import { parseReviewArgs } from "@plannotator/shared/review-args";
import { urlToMarkdown, isConvertedSource } from "@plannotator/shared/url-to-markdown";
import { buildLocalWorkspaceReview, type WorkspaceDiffType } from "@plannotator/server/review-workspace";
import { statSync } from "fs";
import path from "path";
import { resolveValidatedTargetAgent } from "./agent-switch";
import { deliverOpenCodePrompt } from "./prompt-delivery-error";

/** Shared dependencies injected by the plugin */
export interface CommandDeps {
  client: any;
  htmlContent: string;
  reviewHtmlContent: string;
  getSharingEnabled: () => Promise<boolean>;
  getShareBaseUrl: () => string | undefined;
  getPasteApiUrl: () => string | undefined;
  directory?: string;
  /**
   * Annotate server starter. Injectable so tests can supply a stub without a
   * global `mock.module` (which Bun cannot scope per-file or unset, and which
   * would leak into other suites). Defaults to the real annotate server.
   */
  startAnnotateServer?: typeof startAnnotateServer;
}

export async function handleReviewCommand(
  event: any,
  deps: CommandDeps
) {
  const { client, reviewHtmlContent, getSharingEnabled, getShareBaseUrl, directory } = deps;

  // @ts-ignore - Event properties contain arguments
  const reviewArgs = parseReviewArgs(event.properties?.arguments || "");
  const urlArg = reviewArgs.prUrl;
  const isPRMode = urlArg !== undefined;

  let rawPatch: string;
  let gitRef: string;
  let diffError: string | undefined;
  let initialFingerprint: string | undefined;
  let userDiffType: DiffType | WorkspaceDiffType | undefined;
  let gitContext: Awaited<ReturnType<typeof prepareLocalReviewDiff>>["gitContext"] | undefined;
  let prMetadata: Awaited<ReturnType<typeof fetchPR>>["metadata"] | undefined;
  let workspace: Awaited<ReturnType<typeof buildLocalWorkspaceReview>> | undefined;
  let agentCwd: string | undefined;

  if (isPRMode) {
    const prRef = parsePRUrl(urlArg);
    if (!prRef) {
      client.app.log({ level: "error", message: `Invalid PR/MR URL: ${urlArg}` });
      return;
    }

    client.app.log({ level: "info", message: `Fetching ${getMRLabel(prRef)} ${getMRNumberLabel(prRef)} from ${getDisplayRepo(prRef)}...` });

    try {
      await checkPRAuth(prRef);
    } catch (err) {
      const cliName = getCliName(prRef);
      client.app.log({ level: "error", message: err instanceof Error ? err.message : `${cliName} auth check failed` });
      return;
    }

    try {
      const pr = await fetchPR(prRef);
      rawPatch = pr.rawPatch;
      gitRef = `${getMRLabel(prRef)} ${getMRNumberLabel(prRef)}`;
      prMetadata = pr.metadata;
    } catch (err) {
      client.app.log({ level: "error", message: err instanceof Error ? err.message : `Failed to fetch ${getMRLabel(prRef)} ${getMRNumberLabel(prRef)}` });
      return;
    }
  } else {
    client.app.log({ level: "info", message: "Opening code review UI..." });

    const config = loadConfig();
    const cwd = directory ?? process.cwd();
    const managedVcs = await detectManagedVcs(cwd, reviewArgs.vcsType);
    const forcedVcs = !!reviewArgs.vcsType && reviewArgs.vcsType !== "auto";
    if (managedVcs || forcedVcs) {
      try {
        const diffResult = await prepareLocalReviewDiff({
          cwd,
          vcsType: reviewArgs.vcsType,
          configuredDiffType: resolveDefaultDiffType(config),
          hideWhitespace: config.diffOptions?.hideWhitespace ?? false,
        });
        gitContext = diffResult.gitContext;
        userDiffType = diffResult.diffType;
        rawPatch = diffResult.rawPatch;
        gitRef = diffResult.gitRef;
        diffError = diffResult.error;
        initialFingerprint = diffResult.fingerprint;
      } catch (err) {
        client.app.log({ level: "error", message: err instanceof Error ? err.message : "Failed to prepare local review diff" });
        return;
      }
    } else {
      workspace = await buildLocalWorkspaceReview(cwd, {
        configuredDiffType: resolveDefaultDiffType(config),
        hideWhitespace: config.diffOptions?.hideWhitespace ?? false,
      });
      if (workspace.repos.length === 0) {
        client.app.log({ level: "error", message: "Not in a VCS repo and no nested Git/JJ/GitButler repositories were found." });
        return;
      }
      rawPatch = workspace.rawPatch;
      gitRef = workspace.gitRef;
      diffError = workspace.error;
      userDiffType = workspace.diffType;
      agentCwd = workspace.root;
    }
  }

  const server = await startReviewServer({
    rawPatch,
    gitRef,
    error: diffError,
    origin: "opencode",
    project: (await detectProjectName()) ?? undefined,
    diffType: isPRMode ? undefined : userDiffType,
    gitContext,
    initialFingerprint,
    prMetadata,
    workspace,
    agentCwd,
    sharingEnabled: await getSharingEnabled(),
    shareBaseUrl: getShareBaseUrl(),
    htmlContent: reviewHtmlContent,
    opencodeClient: client,
    onReady: (url, isRemote, port) => {
      handleReviewServerReady(url, isRemote, port);
      client.app.log({ level: "info", message: `[Plannotator] Open code review: ${url}` });
    },
  });

  const result = await server.waitForDecision();
  await Bun.sleep(1500);
  server.stop();

  if (result.exit) {
    return;
  }

  if (result.feedback) {
    // @ts-ignore - Event properties contain sessionID
    const sessionId = event.properties?.sessionID;

    if (sessionId) {
      const targetAgent = await resolveValidatedTargetAgent({
        client,
        targetAgent: result.agentSwitch,
        directory,
      });

      // Append the verification-only suffix when the reviewer sent annotations to
      // act on (PR mode included). Platform PR actions post a status message
      // with no annotations — those go through verbatim, no suffix.
      const message = result.approved
        ? getReviewApprovedPrompt("opencode")
        : result.annotations.length > 0
          ? `${result.feedback}${getReviewDeniedSuffix("opencode")}`
          : result.feedback;

      try {
        await client.session.prompt({
          path: { id: sessionId },
          body: {
            ...(targetAgent && { agent: targetAgent }),
            parts: [{ type: "text", text: message }],
          },
        });
      } catch {
        // Session may not be available
      }
    }
  }
}

export async function handleAnnotateCommand(
  event: any,
  deps: CommandDeps
) {
  const { client, htmlContent, getSharingEnabled, getShareBaseUrl, getPasteApiUrl, directory } = deps;
  const startServer = deps.startAnnotateServer ?? startAnnotateServer;

  // @ts-ignore - Event properties contain arguments
  const rawArgs = event.properties?.arguments || event.arguments || "";
  // Split known annotate flags out of the args; rest is the file path.
  // --json is accepted silently (OpenCode writes to session, not stdout).
  // parseAnnotateArgs strips leading @ on filePath (reference-mode convention).
  // `rawFilePath` preserves it for the scoped-package markdown fallback.
  let { filePath, rawFilePath, gate, renderHtml: renderHtmlFlag, renderMarkdown: renderMarkdownFlag, noJina } = parseAnnotateArgs(rawArgs);
  // @ts-ignore - Event properties contain sessionID
  const sessionId = event.properties?.sessionID;

  if (!filePath) {
    client.app.log({ level: "error", message: "Usage: /plannotator-annotate <file.md | file.txt | file.html | https://... | folder/> [--markdown] [--no-jina] [--gate] [--json]" });
    return;
  }

  // Tolerant fallback (#1182): when the whole argument string names nothing,
  // probe each token; exactly one existing target proceeds, several is an
  // error, several unresolvable words get an actionable message instead of
  // "File not found: the". Bare directory names only count in the sole-arg
  // pre-pass, and unrecognized dash-prefixed tokens disable tolerance so a
  // typo'd flag errors the way it always did.
  const tolerantRoot = directory || process.cwd();
  if (!annotateInputNamesExistingTarget(rawFilePath, tolerantRoot)) {
    const selection = selectAnnotateTokenTarget(rawFilePath, (token) =>
      probeAnnotateToken(token, tolerantRoot, { bareDirectories: false }),
    );
    if (selection.kind === "single") {
      filePath = selection.candidate.value;
      rawFilePath = selection.candidate.value;
    } else if (selection.kind === "multiple") {
      client.app.log({ level: "error", message: buildAmbiguousAnnotateArgsMessage(selection.candidates) });
      return;
    } else if (selection.kind === "none" && selection.words.length > 1) {
      // Content flags only; --gate is transport for this invocation, not a
      // property of the target.
      const flags = [
        ...(renderMarkdownFlag ? ["--markdown"] : []),
        ...(noJina ? ["--no-jina"] : []),
        ...(renderHtmlFlag ? ["--render-html"] : []),
      ];
      client.app.log({ level: "error", message: buildUnresolvedAnnotateArgsMessage({ words: selection.words, flags }) });
      return;
    }
    // "flagged" (unrecognized dash tokens) or a single unresolvable word
    // falls through to the existing pipeline so its specific errors
    // ("File not found", unsupported type) stay verbatim.
  }

  let markdown: string;
  let rawHtml: string | undefined;
  let absolutePath: string;
  let folderPath: string | undefined;
  let annotateMode: "annotate" | "annotate-folder" = "annotate";
  let isFolder = false;
  let sourceInfo: string | undefined;
  let sourceConverted = false;
  const agentCwd = directory || process.cwd();

  // --- URL annotation ---
  const isUrl = /^https?:\/\//i.test(filePath);

  if (isUrl) {
    const useJina = resolveUseJina(noJina, loadConfig());
    client.app.log({ level: "info", message: `Fetching: ${filePath}${useJina ? " (via Jina Reader)" : " (via fetch+Turndown)"}...` });
    try {
      const result = await urlToMarkdown(filePath, { useJina });
      markdown = result.markdown;
      sourceConverted = isConvertedSource(result.source);
    } catch (err) {
      client.app.log({ level: "error", message: `Failed to fetch URL: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    absolutePath = filePath;
    sourceInfo = filePath;
  } else {
    const projectRoot = agentCwd;
    const resolvedArg = resolveUserPath(filePath, projectRoot);

    try {
      isFolder = statSync(resolvedArg).isDirectory();
    } catch {
      // Not a directory, fall through to file resolution.
    }

    if (isFolder) {
      if (!hasMarkdownFiles(resolvedArg, FILE_BROWSER_EXCLUDED, getAnnotatableDocRegex())) {
        client.app.log({ level: "error", message: `No annotatable files (markdown, plain-text, config, or HTML) found in ${resolvedArg}` });
        return;
      }
      folderPath = resolvedArg;
      absolutePath = resolvedArg;
      markdown = "";
      annotateMode = "annotate-folder";
      client.app.log({ level: "info", message: `Opening annotation UI for folder ${resolvedArg}...` });
    } else if (/\.html?$/i.test(resolvedArg)) {
      try {
        statSync(resolvedArg);
      } catch {
        client.app.log({ level: "error", message: `File not found: ${filePath}` });
        return;
      }
      const html = await Bun.file(resolvedArg).text();
      const renderHtmlForFile = !renderMarkdownFlag;
      if (renderHtmlForFile) {
        rawHtml = html;
        markdown = "";
      } else {
        markdown = htmlToMarkdown(html);
        sourceConverted = true;
      }
      absolutePath = resolvedArg;
      sourceInfo = path.basename(resolvedArg);
      client.app.log({ level: "info", message: `${renderHtmlForFile ? "Raw HTML" : "Converted"}: ${absolutePath}` });
    } else {
      // Markdown file annotation
      client.app.log({ level: "info", message: `Opening annotation UI for ${filePath}...` });
      // Strip-first with literal-@ fallback (scoped-package-style names).
      let resolved = await resolveMarkdownFile(filePath, projectRoot);
      if (resolved.kind === "not_found" && rawFilePath !== filePath) {
        resolved = await resolveMarkdownFile(rawFilePath, projectRoot);
      }

      if (resolved.kind === "ambiguous") {
        client.app.log({
          level: "error",
          message: `Ambiguous filename "${resolved.input}" — found ${resolved.matches.length} matches:\n${resolved.matches.map((m) => `  ${m}`).join("\n")}`,
        });
        return;
      }
      if (resolved.kind === "not_found") {
        client.app.log({ level: "error", message: `File not found: ${resolved.input}` });
        return;
      }

      absolutePath = resolved.path;
      if (Bun.file(absolutePath).size > MAX_ANNOTATABLE_FILE_BYTES) {
        client.app.log({ level: "error", message: `File too large to annotate (max 2MB): ${absolutePath}` });
        return;
      }
      client.app.log({ level: "info", message: `Resolved: ${absolutePath}` });
      markdown = await Bun.file(absolutePath).text();
    }
  }

  // Per-project scoping for the annotate version history — matches the hook
  // and Pi runtimes, which both pass it (otherwise history lands in the
  // shared "_unknown" bucket).
  const annotateProject = (await detectProjectName()) ?? undefined;
  const server = await startServer({
    markdown,
    filePath: absolutePath,
    origin: "opencode",
    mode: annotateMode,
    project: annotateProject,
    folderPath,
    sourceInfo,
    sourceConverted,
    rawHtml,
    renderHtml: !!rawHtml,
    convertHtml: renderMarkdownFlag,
    sharingEnabled: await getSharingEnabled(),
    shareBaseUrl: getShareBaseUrl(),
    pasteApiUrl: getPasteApiUrl(),
    gate,
    approvalNotesSupported: Boolean(sessionId),
    agentCwd,
    htmlContent,
    onReady: (url, isRemote, port) => {
      handleAnnotateServerReady(url, isRemote, port);
      client.app.log({ level: "info", message: `[Plannotator] Open annotation UI: ${url}` });
    },
  });

  const result = await server.waitForDecision();
  await Bun.sleep(1500);
  server.stop();

  if (result.exit || (result.approved && !result.feedback)) {
    return;
  }

  if (result.feedback) {
    if (sessionId) {
      const text = result.approved
        ? getAnnotateApprovedWithNotesPrompt("opencode", undefined, {
            context: `${isFolder ? "Folder" : "File"}: ${absolutePath}`,
            feedback: result.feedback,
          })
        : getAnnotateFileFeedbackPrompt("opencode", undefined, {
            fileHeader: isFolder ? "Folder" : "File",
            filePath: absolutePath,
            feedback: result.feedback,
          });
      await deliverOpenCodePrompt({
        client,
        prompt: {
          path: { id: sessionId },
          body: {
            parts: [{
              type: "text",
              text,
            }],
          },
        },
        failureMessage: result.approved
          ? "Could not deliver approved annotation notes to the OpenCode session."
          : "Could not deliver annotation feedback to the OpenCode session.",
      });
    }
  }
}

/**
 * Handle /plannotator-last command.
 * Called from command.execute.before — returns approval-aware feedback so the
 * caller can choose the correct prompt semantics before injecting it.
 */
export async function handleAnnotateLastCommand(
  event: any,
  deps: CommandDeps
): Promise<{ approved: boolean; feedback: string } | null> {
  const { client, htmlContent, getSharingEnabled, getShareBaseUrl, getPasteApiUrl } = deps;
  const startServer = deps.startAnnotateServer ?? startAnnotateServer;

  // @ts-ignore - Event properties contain arguments
  const rawArgs = event.properties?.arguments || event.arguments || "";
  // Support --gate on /plannotator-last (Stop-hook review-gate pattern).
  const { gate } = parseAnnotateArgs(rawArgs);

  // @ts-ignore - Event properties contain sessionID
  const sessionId = event.properties?.sessionID;
  if (!sessionId) {
    client.app.log({ level: "error", message: "No active session." });
    return null;
  }

  // Fetch messages from session
  const messagesResponse = await client.session.messages({
    path: { id: sessionId },
  });
  const messages = messagesResponse.data;

  const RECENT_LIMIT = 25;
  const recentMessages: { messageId: string; text: string; timestamp?: string }[] = [];
  if (messages) {
    for (let i = messages.length - 1; i >= 0 && recentMessages.length < RECENT_LIMIT; i--) {
      const msg = messages[i];
      if (msg.info.role !== "assistant") continue;
      const textParts = msg.parts
        .filter((p: any) => p.type === "text" && p.text?.trim())
        .map((p: any) => p.text);
      if (textParts.length === 0) continue;
      recentMessages.push({
        messageId: msg.info.id ?? `opencode-${i}`,
        text: textParts.join("\n"),
        timestamp: msg.info.time?.created ? new Date(msg.info.time.created).toISOString() : undefined,
      });
    }
  }

  const lastText = recentMessages[0]?.text ?? null;
  if (!lastText) {
    client.app.log({ level: "error", message: "No assistant message found in session." });
    return null;
  }

  client.app.log({ level: "info", message: "Opening annotation UI for last message..." });

  const pickerMessages = recentMessages.length > 1 ? recentMessages : undefined;

  const lastProject = (await detectProjectName()) ?? undefined;
  const server = await startServer({
    markdown: lastText,
    filePath: "last-message",
    origin: "opencode",
    mode: "annotate-last",
    project: lastProject,
    recentMessages: pickerMessages,
    sharingEnabled: await getSharingEnabled(),
    shareBaseUrl: getShareBaseUrl(),
    pasteApiUrl: getPasteApiUrl(),
    gate,
    approvalNotesSupported: true,
    htmlContent,
    onReady: (url, isRemote, port) => {
      handleAnnotateServerReady(url, isRemote, port);
      client.app.log({ level: "info", message: `[Plannotator] Open annotation UI: ${url}` });
    },
  });

  const result = await server.waitForDecision();
  await Bun.sleep(1500);
  server.stop();

  if (result.exit || (result.approved && !result.feedback)) {
    return null;
  }

  return result.feedback
    ? { approved: Boolean(result.approved), feedback: result.feedback }
    : null;
}
