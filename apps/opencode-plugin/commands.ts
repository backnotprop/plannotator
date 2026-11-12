import { diagramEngineSourcesFromDir } from "@plannotator/shared/diagram-engine-assets";
import {
  startReviewServer,
  handleReviewServerReady,
} from "@plannotator/server/review";
import {
  startAnnotateServer,
  handleAnnotateServerReady,
} from "@plannotator/server/annotate";
import { type DiffType, prepareLocalReviewDiff, detectManagedVcs, gitRuntime } from "@plannotator/server/vcs";
import { resolveReviewOpenState } from "@plannotator/shared/review-open-state";
import { detectProjectName } from "@plannotator/server/project";
import { parsePRUrl, checkPRAuth, fetchPR, getCliName, getMRLabel, getMRNumberLabel, getDisplayRepo } from "@plannotator/server/pr";
import { loadConfig, resolveDefaultDiffType, resolveDefaultDiffTypeFor, resolveUseJina } from "@plannotator/shared/config";
import {
  composeReviewApprovedMessage,
  getAnnotateApprovedWithNotesPrompt,
  getReviewDeniedSuffix,
  getAnnotateFileFeedbackPrompt,
} from "@plannotator/shared/prompts";
import { resolveMarkdownFile, resolveUserPath, hasMarkdownFiles, getAnnotatableDocRegex, MAX_ANNOTATABLE_FILE_BYTES } from "@plannotator/shared/resolve-file";
import { FILE_BROWSER_EXCLUDED } from "@plannotator/shared/reference-common";
import { htmlToMarkdown } from "@plannotator/shared/html-to-markdown";
import { parseAnnotateArgs } from "@plannotator/shared/annotate-args";
import {
  annotateInputNamesExistingTarget,
  annotatePathExists,
  buildAmbiguousAnnotateArgsMessage,
  buildMissingAnnotateFilesMessage,
  buildUnresolvedAnnotateArgsMessage,
  probeAnnotateBundlePath,
  probeAnnotateToken,
  resolveAnnotateBundleFiles,
  selectAnnotateTokenTarget,
} from "@plannotator/shared/annotate-target";
import {
  annotateBundleRoot,
  annotateBundleTargetText,
  type AnnotateBundleFile,
} from "@plannotator/shared/annotate-bundle";
import { formatIgnoredReviewWords, parseReviewArgs, resolveReviewTarget, withReviewDirectory } from "@plannotator/shared/review-args";
import { urlToMarkdown, isConvertedSource } from "@plannotator/shared/url-to-markdown";
import { buildLocalWorkspaceReview, type WorkspaceDiffType } from "@plannotator/server/review-workspace";
import { statSync } from "fs";
import path from "path";
import { resolveValidatedTargetAgent } from "./agent-switch";
import { deliverOpenCodePrompt } from "./prompt-delivery-error";
import { announceSessionUrl } from "./session-url";
import { scheduleOpenCodeDailyPing } from "./daily-ping";
import { decideListed } from "./session-registry";
import {
  readLastUserAgent,
  readMessageAgent,
  resolveAddressableAgent,
  resolveAnnotatedMessageAgent,
} from "./message-agent";

export interface CommandDeps {
  client: any;
  htmlContent: string;
  reviewHtmlContent: string;
  reviewDiagramEngineDir?: string;
  getSharingEnabled: () => Promise<boolean>;
  getShareBaseUrl: () => string | undefined;
  getPasteApiUrl: () => string | undefined;
  directory?: string;
  startAnnotateServer?: typeof startAnnotateServer;
  startReviewServer?: typeof startReviewServer;
}

export async function handleReviewCommand(
  event: any,
  deps: CommandDeps
) {
  const { client, reviewHtmlContent, getSharingEnabled, getShareBaseUrl, directory } = deps;

  // @ts-ignore - Event properties contain arguments
  const reviewArgs = parseReviewArgs(event.properties?.arguments || "");
  if (reviewArgs.errors.length > 0) {
    for (const parseError of reviewArgs.errors) {
      client.app.log({ level: "error", message: `[Plannotator] ${parseError}` });
    }
    return;
  }
  const urlArg = reviewArgs.prUrl;
  let reviewDirectory: string | undefined;
  try {
    const target = resolveReviewTarget(reviewArgs, directory ?? process.cwd());
    reviewDirectory = target.directory;
    const notice = formatIgnoredReviewWords(target);
    if (notice) client.app.log({ level: "info", message: `[Plannotator] ${notice}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    client.app.log({ level: "error", message });
    try {
      const result = client.tui?.showToast?.({ body: { title: "Plannotator", message, variant: "error" } });
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {
    }
    return;
  }
  let reviewCwd = reviewDirectory ?? directory ?? process.cwd();
  const isPRMode = urlArg !== undefined;
  const openStatePinned = reviewArgs.base !== undefined || reviewArgs.diffType !== undefined;
  let initialBaseFromFlags: string | undefined;
  let initialBaseExplicit = false;

  let rawPatch: string;
  let gitRef: string;
  let diffError: string | undefined;
  let initialFingerprint: string | undefined;
  let initialFileIdentities: Record<string, string> | undefined;
  let userDiffType: DiffType | WorkspaceDiffType | undefined;
  let gitContext: Awaited<ReturnType<typeof prepareLocalReviewDiff>>["gitContext"] | undefined;
  let prMetadata: Awaited<ReturnType<typeof fetchPR>>["metadata"] | undefined;
  let workspace: Awaited<ReturnType<typeof buildLocalWorkspaceReview>> | undefined;
  let agentCwd: string | undefined;

  if (isPRMode) {
    if (openStatePinned) {
      const openState = resolveReviewOpenState({
        parsed: reviewArgs,
        isPRMode: true,
        isWorkspace: false,
        resolvedDefaultDiffType: resolveDefaultDiffType(loadConfig()),
      });
      if (openState.error) {
        client.app.log({ level: "error", message: `[Plannotator] ${openState.error}` });
        return;
      }
    }
    const prRef = parsePRUrl(urlArg);
    if (!prRef) {
      client.app.log({ level: "error", message: `Invalid PR/MR URL: ${urlArg}` });
      return;
    }

    client.app.log({ level: "info", message: `Fetching ${getMRLabel(prRef)} ${getMRNumberLabel(prRef)} from ${getDisplayRepo(prRef)}...` });

    try {
      const access = await checkPRAuth(prRef);
      if (access.notice) client.app.log({ level: "info", message: `[Plannotator] ${access.notice}` });
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
    const managedVcs = await detectManagedVcs(reviewCwd, reviewArgs.vcsType);
    if (reviewDirectory) reviewCwd = await managedVcs?.getRoot?.(reviewCwd) ?? reviewCwd;
    const cwd = reviewCwd;
    const forcedVcs = !!reviewArgs.vcsType && reviewArgs.vcsType !== "auto";
    if (managedVcs || forcedVcs) {
      const providerId = (managedVcs?.id ?? reviewArgs.vcsType) as
        | "git"
        | "gitbutler"
        | "jj"
        | "p4"
        | undefined;
      let baseResolves: boolean | undefined;
      if (openStatePinned && reviewArgs.base !== undefined && providerId === "git") {
        const probe = await gitRuntime.runGit(
          ["rev-parse", "--verify", "--quiet", "--end-of-options", `${reviewArgs.base}^{commit}`],
          { cwd },
        );
        baseResolves = probe.exitCode === 0;
      }
      const openState = resolveReviewOpenState({
        parsed: reviewArgs,
        isPRMode: false,
        isWorkspace: false,
        providerId,
        resolvedDefaultDiffType: resolveDefaultDiffType(config),
        baseResolves,
      });
      if (openState.error) {
        client.app.log({ level: "error", message: `[Plannotator] ${openState.error}` });
        return;
      }
      for (const notice of openState.notices) {
        client.app.log({ level: "info", message: `[Plannotator] ${notice}` });
      }
      try {
        const diffResult = await prepareLocalReviewDiff({
          cwd,
          vcsType: reviewArgs.vcsType,
          requestedDiffType: openState.requestedDiffType,
          requestedBase: openState.requestedBase,
          configuredDiffType: resolveDefaultDiffTypeFor(config, managedVcs?.id),
          hideWhitespace: config.diffOptions?.hideWhitespace ?? false,
        });
        gitContext = diffResult.gitContext;
        userDiffType = diffResult.diffType;
        rawPatch = diffResult.rawPatch;
        gitRef = diffResult.gitRef;
        diffError = diffResult.error;
        initialFingerprint = diffResult.fingerprint;
        if (openState.requestedBase !== undefined || diffResult.diffType === "jj-evolog") initialBaseFromFlags = diffResult.base;
        initialBaseExplicit = openState.requestedBase !== undefined;
        initialFileIdentities = diffResult.fileIdentities;
      } catch (err) {
        client.app.log({ level: "error", message: err instanceof Error ? err.message : "Failed to prepare local review diff" });
        return;
      }
    } else {
      if (openStatePinned) {
        const openState = resolveReviewOpenState({
          parsed: reviewArgs,
          isPRMode: false,
          isWorkspace: true,
          resolvedDefaultDiffType: resolveDefaultDiffType(config),
        });
        if (openState.error) {
          client.app.log({ level: "error", message: `[Plannotator] ${openState.error}` });
          return;
        }
      }
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

  // @ts-ignore - Event properties contain sessionID
  const sessionId = event.properties?.sessionID;

  const startServer = deps.startReviewServer ?? startReviewServer;
  scheduleOpenCodeDailyPing("review");
  const reviewProject = (await detectProjectName(reviewDirectory ? reviewCwd : undefined)) ?? undefined;
  const server = await startServer({
    rawPatch,
    gitRef,
    error: diffError,
    origin: "opencode",
    project: reviewProject,
    includeReviewDirectory: !!reviewDirectory,
    diffType: isPRMode ? undefined : userDiffType,
    gitContext,
    initialBase: initialBaseFromFlags,
    initialBaseExplicit,
    openStatePinned,
    gitRemoteCheck: reviewArgs.gitRemoteCheck,
    initialFingerprint,
    initialFileIdentities,
    prMetadata,
    workspace,
    agentCwd,
    sharingEnabled: await getSharingEnabled(),
    shareBaseUrl: getShareBaseUrl(),
    approvalNotesSupported: Boolean(sessionId),
    htmlContent: reviewHtmlContent,
    diagramEngine: deps.reviewDiagramEngineDir ? diagramEngineSourcesFromDir(deps.reviewDiagramEngineDir) : undefined,
    opencodeClient: client,
    onReady: (url, isRemote, port) => {
      handleReviewServerReady(url, isRemote, port, { announce: false });
      announceSessionUrl(client, "code review", url);
    },
  });

  const result = await decideListed(server, "review", reviewProject);
  result.feedback = withReviewDirectory(result.feedback, result.reviewDirectory);

  if (result.exit) {
    return;
  }

  if (result.feedback || result.approved) {
    if (sessionId) {
      const targetAgent = await resolveValidatedTargetAgent({
        client,
        targetAgent: result.agentSwitch,
        directory,
      });

      const message = result.approved
        ? composeReviewApprovedMessage("opencode", result.feedback)
        : result.platform === true
          ? result.feedback
          : `${result.feedback}${getReviewDeniedSuffix("opencode")}`;

      try {
        await client.session.prompt({
          path: { id: sessionId },
          body: {
            ...(targetAgent && { agent: targetAgent }),
            parts: [{ type: "text", text: message }],
          },
        });
      } catch {
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
  scheduleOpenCodeDailyPing("annotate");

  // @ts-ignore - Event properties contain arguments
  const rawArgs = event.properties?.arguments || event.arguments || "";
  let { filePath, rawFilePath, gate, renderHtml: renderHtmlFlag, renderMarkdown: renderMarkdownFlag, noJina } = parseAnnotateArgs(rawArgs);
  // @ts-ignore - Event properties contain sessionID
  const sessionId = event.properties?.sessionID;

  if (!filePath) {
    client.app.log({ level: "error", message: "Usage: /plannotator-annotate <file.md | file.txt | file.html | https://... | folder/> [--markdown] [--no-jina] [--gate] [--json]" });
    return;
  }

  const tolerantRoot = directory || process.cwd();
  let bundleFiles: AnnotateBundleFile[] | undefined;
  if (!annotateInputNamesExistingTarget(rawFilePath, tolerantRoot)) {
    const selection = selectAnnotateTokenTarget(
      rawFilePath,
      (token) => probeAnnotateToken(token, tolerantRoot, { bareDirectories: false }),
      { bundlePath: (token) => probeAnnotateBundlePath(token, tolerantRoot), pathExists: (token) => annotatePathExists(token, tolerantRoot) },
    );
    if (selection.kind === "missing") {
      client.app.log({ level: "error", message: buildMissingAnnotateFilesMessage(selection.missing) });
      return;
    } else if (selection.kind === "bundle") {
      const checked = resolveAnnotateBundleFiles(
        selection.files.map((file) => file.value),
        { convertHtml: renderMarkdownFlag },
      );
      if (!checked.ok) {
        client.app.log({ level: "error", message: checked.message });
        return;
      }
      bundleFiles = checked.files;
    } else if (selection.kind === "single") {
      filePath = selection.candidate.value;
      rawFilePath = selection.candidate.value;
    } else if (selection.kind === "multiple") {
      client.app.log({ level: "error", message: buildAmbiguousAnnotateArgsMessage(selection.candidates, { bundleHint: true }) });
      return;
    } else if (selection.kind === "none" && selection.words.length > 1) {
      const flags = [
        ...(renderMarkdownFlag ? ["--markdown"] : []),
        ...(noJina ? ["--no-jina"] : []),
        ...(renderHtmlFlag ? ["--render-html"] : []),
      ];
      client.app.log({ level: "error", message: buildUnresolvedAnnotateArgsMessage({ words: selection.words, flags }) });
      return;
    }
  }

  let markdown: string;
  let rawHtml: string | undefined;
  let absolutePath: string;
  let folderPath: string | undefined;
  let annotateMode: "annotate" | "annotate-folder" | "annotate-bundle" = "annotate";
  let isFolder = false;
  let sourceInfo: string | undefined;
  let sourceConverted = false;
  const agentCwd = directory || process.cwd();

  const isUrl = !bundleFiles && /^https?:\/\//i.test(filePath);

  if (bundleFiles) {
    markdown = "";
    absolutePath = annotateBundleRoot(bundleFiles.map((file) => file.path));
    annotateMode = "annotate-bundle";
    client.app.log({ level: "info", message: `Opening annotation UI for ${bundleFiles.length} files...` });
  } else if (isUrl) {
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
      client.app.log({ level: "info", message: `Opening annotation UI for ${filePath}...` });
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

  const annotateProject = (await detectProjectName()) ?? undefined;
  const server = await startServer({
    markdown,
    filePath: absolutePath,
    origin: "opencode",
    mode: annotateMode,
    project: annotateProject,
    folderPath,
    bundleFiles,
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
      handleAnnotateServerReady(url, isRemote, port, { announce: false });
      announceSessionUrl(client, "annotation UI", url);
    },
  });

  const result = await decideListed(server, "annotate", annotateProject);

  if (result.exit || (result.approved && !result.feedback) || result.nothingToSend === true) {
    return;
  }

  if (result.feedback) {
    if (sessionId) {
      let sessionAgent: string | undefined;
      try {
        const response = await client.session?.messages?.({ path: { id: sessionId } });
        sessionAgent = readLastUserAgent(response?.data);
      } catch {
        sessionAgent = undefined;
      }
      const agent = await resolveAddressableAgent({ client, agent: sessionAgent, directory });
      const fileHeader = bundleFiles ? "Files" : isFolder ? "Folder" : "File";
      const targetText = bundleFiles
        ? annotateBundleTargetText(bundleFiles.map((file) => file.path))
        : absolutePath;
      const text = result.approved
        ? getAnnotateApprovedWithNotesPrompt("opencode", undefined, {
            context: `${fileHeader}: ${targetText}`,
            feedback: result.feedback,
          })
        : getAnnotateFileFeedbackPrompt("opencode", undefined, {
            fileHeader,
            filePath: targetText,
            feedback: result.feedback,
          });
      await deliverOpenCodePrompt({
        client,
        prompt: {
          path: { id: sessionId },
          body: {
            ...(agent && { agent }),
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

export async function handleAnnotateLastCommand(
  event: any,
  deps: CommandDeps
): Promise<{ approved: boolean; feedback: string; agent?: string } | null> {
  const { client, htmlContent, getSharingEnabled, getShareBaseUrl, getPasteApiUrl, directory } = deps;
  const startServer = deps.startAnnotateServer ?? startAnnotateServer;
  scheduleOpenCodeDailyPing("last");

  // @ts-ignore - Event properties contain arguments
  const rawArgs = event.properties?.arguments || event.arguments || "";
  const { gate } = parseAnnotateArgs(rawArgs);

  // @ts-ignore - Event properties contain sessionID
  const sessionId = event.properties?.sessionID;
  if (!sessionId) {
    client.app.log({ level: "error", message: "No active session." });
    return null;
  }

  const messagesResponse = await client.session.messages({
    path: { id: sessionId },
  });
  const messages = messagesResponse.data;

  const RECENT_LIMIT = 25;
  const recentMessages: { messageId: string; text: string; timestamp?: string }[] = [];
  const messageAgents: { messageId: string; agent?: string }[] = [];
  if (messages) {
    for (let i = messages.length - 1; i >= 0 && recentMessages.length < RECENT_LIMIT; i--) {
      const msg = messages[i];
      if (msg.info.role !== "assistant") continue;
      const textParts = msg.parts
        .filter((p: any) => p.type === "text" && p.text?.trim())
        .map((p: any) => p.text);
      if (textParts.length === 0) continue;
      const messageId = msg.info.id ?? `opencode-${i}`;
      recentMessages.push({
        messageId,
        text: textParts.join("\n"),
        timestamp: msg.info.time?.created ? new Date(msg.info.time.created).toISOString() : undefined,
      });
      messageAgents.push({ messageId, agent: readMessageAgent(msg.info) });
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
      handleAnnotateServerReady(url, isRemote, port, { announce: false });
      announceSessionUrl(client, "annotation UI", url);
    },
  });

  const result = await decideListed(server, "annotate", lastProject);

  if (result.exit || (result.approved && !result.feedback) || result.nothingToSend === true) {
    return null;
  }

  if (!result.feedback) return null;

  const agent = await resolveAddressableAgent({
    client,
    agent: resolveAnnotatedMessageAgent(messageAgents, result),
    directory,
  });
  return {
    approved: Boolean(result.approved),
    feedback: result.feedback,
    ...(agent && { agent }),
  };
}
