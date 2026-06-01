/**
 * Command Handlers for OpenCode Plugin
 *
 * Handles /plannotator-review, /plannotator-annotate, /plannotator-last,
 * and /plannotator-archive slash commands. Extracted from the event hook
 * for modularity.
 */

import {
  startPlannotatorServer,
  handleServerReady,
} from "@plannotator/server";
import {
  startReviewServer,
  handleReviewServerReady,
} from "@plannotator/server/review";
import {
  startAnnotateServer,
  handleAnnotateServerReady,
} from "@plannotator/server/annotate";
import { type DiffType, prepareLocalReviewDiff } from "@plannotator/server/vcs";
import { parsePRUrl, checkPRAuth, fetchPR, getCliName, getMRLabel, getMRNumberLabel, getDisplayRepo } from "@plannotator/server/pr";
import { loadConfig, resolveDefaultDiffType, resolveUseJina } from "@plannotator/shared/config";
import {
  getReviewApprovedPrompt,
  getReviewDeniedSuffix,
  getAnnotateFileFeedbackPrompt,
} from "@plannotator/shared/prompts";
import { resolveMarkdownFile, resolveUserPath, hasMarkdownFiles } from "@plannotator/shared/resolve-file";
import { FILE_BROWSER_EXCLUDED } from "@plannotator/shared/reference-common";
import { htmlToMarkdown } from "@plannotator/shared/html-to-markdown";
import { parseAnnotateArgs } from "@plannotator/shared/annotate-args";
import { parseReviewArgs } from "@plannotator/shared/review-args";
import { urlToMarkdown, isConvertedSource } from "@plannotator/shared/url-to-markdown";
import { statSync } from "fs";
import path from "path";

/** Shared dependencies injected by the plugin */
export interface CommandDeps {
  client: any;
  htmlContent: string;
  reviewHtmlContent: string;
  getSharingEnabled: () => Promise<boolean>;
  getShareBaseUrl: () => string | undefined;
  getPasteApiUrl: () => string | undefined;
  directory?: string;
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
  let userDiffType: DiffType | undefined;
  let gitContext: Awaited<ReturnType<typeof prepareLocalReviewDiff>>["gitContext"] | undefined;
  let prMetadata: Awaited<ReturnType<typeof fetchPR>>["metadata"] | undefined;

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
    const diffResult = await prepareLocalReviewDiff({
      cwd: directory,
      vcsType: reviewArgs.vcsType,
      configuredDiffType: resolveDefaultDiffType(config),
      hideWhitespace: config.diffOptions?.hideWhitespace ?? false,
    });
    gitContext = diffResult.gitContext;
    userDiffType = diffResult.diffType;
    rawPatch = diffResult.rawPatch;
    gitRef = diffResult.gitRef;
    diffError = diffResult.error;
  }

  const server = await startReviewServer({
    rawPatch,
    gitRef,
    error: diffError,
    origin: "opencode",
    diffType: isPRMode ? undefined : userDiffType,
    gitContext,
    prMetadata,
    sharingEnabled: await getSharingEnabled(),
    shareBaseUrl: getShareBaseUrl(),
    htmlContent: reviewHtmlContent,
    opencodeClient: client,
    onReady: (url, isRemote, port) => {
      handleReviewServerReady(url, isRemote, port);
      if (isRemote) {
        client.app.log({ level: "info", message: `[Plannotator] Open in browser: ${url}` });
      }
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
      const shouldSwitchAgent = result.agentSwitch && result.agentSwitch !== "disabled";
      const targetAgent = result.agentSwitch || "build";

      const message = result.approved
        ? getReviewApprovedPrompt("opencode")
        : isPRMode
          ? result.feedback
          : `${result.feedback}${getReviewDeniedSuffix("opencode")}`;

      try {
        await client.session.prompt({
          path: { id: sessionId },
          body: {
            ...(shouldSwitchAgent && { agent: targetAgent }),
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

  // @ts-ignore - Event properties contain arguments
  const rawArgs = event.properties?.arguments || event.arguments || "";
  // #570: split --gate / --json out of the args; rest is the file path.
  // --json is accepted silently (OpenCode writes to session, not stdout).
  // parseAnnotateArgs strips leading @ on filePath (reference-mode convention).
  // `rawFilePath` preserves it for the scoped-package markdown fallback.
  const { filePath, rawFilePath, gate, renderHtml: renderHtmlFlag } = parseAnnotateArgs(rawArgs);

  if (!filePath) {
    client.app.log({ level: "error", message: "Usage: /plannotator-annotate <file.md | file.html | https://... | folder/> [--gate] [--json]" });
    return;
  }

  let markdown: string;
  let rawHtml: string | undefined;
  let absolutePath: string;
  let folderPath: string | undefined;
  let annotateMode: "annotate" | "annotate-folder" = "annotate";
  let isFolder = false;
  let sourceInfo: string | undefined;
  let sourceConverted = false;

  // --- URL annotation ---
  const isUrl = /^https?:\/\//i.test(filePath);

  if (isUrl) {
    const useJina = resolveUseJina(false, loadConfig());
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
    const projectRoot = directory || process.cwd();
    const resolvedArg = resolveUserPath(filePath, projectRoot);

    try {
      isFolder = statSync(resolvedArg).isDirectory();
    } catch {
      // Not a directory, fall through to file resolution.
    }

    if (isFolder) {
      if (!hasMarkdownFiles(resolvedArg, FILE_BROWSER_EXCLUDED, /\.(mdx?|html?)$/i)) {
        client.app.log({ level: "error", message: `No markdown or HTML files found in ${resolvedArg}` });
        return;
      }
      folderPath = resolvedArg;
      absolutePath = resolvedArg;
      markdown = "";
      annotateMode = "annotate-folder";
      client.app.log({ level: "info", message: `Opening annotation UI for folder ${resolvedArg}...` });
    } else if (/\.html?$/i.test(resolvedArg)) {
      let fileSize: number;
      try {
        fileSize = statSync(resolvedArg).size;
      } catch {
        client.app.log({ level: "error", message: `File not found: ${filePath}` });
        return;
      }
      if (fileSize > 10 * 1024 * 1024) {
        client.app.log({ level: "error", message: `File too large (${Math.round(fileSize / 1024 / 1024)}MB, max 10MB)` });
        return;
      }
      const html = await Bun.file(resolvedArg).text();
      if (renderHtmlFlag) {
        rawHtml = html;
        markdown = "";
      } else {
        markdown = htmlToMarkdown(html);
        sourceConverted = true;
      }
      absolutePath = resolvedArg;
      sourceInfo = path.basename(resolvedArg);
      client.app.log({ level: "info", message: `${renderHtmlFlag ? "Raw HTML" : "Converted"}: ${absolutePath}` });
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
      client.app.log({ level: "info", message: `Resolved: ${absolutePath}` });
      markdown = await Bun.file(absolutePath).text();
    }
  }

  const server = await startAnnotateServer({
    markdown,
    filePath: absolutePath,
    origin: "opencode",
    mode: annotateMode,
    folderPath,
    sourceInfo,
    sourceConverted,
    rawHtml,
    renderHtml: renderHtmlFlag,
    sharingEnabled: await getSharingEnabled(),
    shareBaseUrl: getShareBaseUrl(),
    pasteApiUrl: getPasteApiUrl(),
    gate,
    htmlContent,
    onReady: (url, isRemote, port) => {
      handleAnnotateServerReady(url, isRemote, port);
      if (isRemote) {
        client.app.log({ level: "info", message: `[Plannotator] Open in browser: ${url}` });
      }
    },
  });

  const result = await server.waitForDecision();
  await Bun.sleep(1500);
  server.stop();

  // Both exit and approve are "no-op for the agent" — skip session injection.
  if (result.exit || result.approved) {
    return;
  }

  if (result.feedback) {
    // @ts-ignore - Event properties contain sessionID
    const sessionId = event.properties?.sessionID;

    if (sessionId) {
      try {
        await client.session.prompt({
          path: { id: sessionId },
          body: {
            parts: [{
              type: "text",
              text: getAnnotateFileFeedbackPrompt("opencode", undefined, {
                fileHeader: isFolder ? "Folder" : "File",
                filePath: absolutePath,
                feedback: result.feedback,
              }),
            }],
          },
        });
      } catch {
        // Session may not be available
      }
    }
  }
}

/**
 * Handle /plannotator-last command.
 * Called from command.execute.before — returns the feedback string
 * so the caller can set it as output.parts for the agent to see.
 */
export async function handleAnnotateLastCommand(
  event: any,
  deps: CommandDeps
): Promise<string | null> {
  const { client, htmlContent, getSharingEnabled, getShareBaseUrl, getPasteApiUrl } = deps;

  // @ts-ignore - Event properties contain arguments
  const rawArgs = event.properties?.arguments || event.arguments || "";
  // #570: support --gate on /plannotator-last (Stop-hook review-gate pattern).
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

  // Walk backward, find last assistant message with text
  let lastText: string | null = null;
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.info.role === "assistant") {
        const textParts = msg.parts
          .filter((p: any) => p.type === "text" && p.text?.trim())
          .map((p: any) => p.text);
        if (textParts.length > 0) {
          lastText = textParts.join("\n");
          break;
        }
      }
    }
  }

  if (!lastText) {
    client.app.log({ level: "error", message: "No assistant message found in session." });
    return null;
  }

  client.app.log({ level: "info", message: "Opening annotation UI for last message..." });

  const server = await startAnnotateServer({
    markdown: lastText,
    filePath: "last-message",
    origin: "opencode",
    mode: "annotate-last",
    sharingEnabled: await getSharingEnabled(),
    shareBaseUrl: getShareBaseUrl(),
    pasteApiUrl: getPasteApiUrl(),
    gate,
    htmlContent,
    onReady: (url, isRemote, port) => {
      handleAnnotateServerReady(url, isRemote, port);
      if (isRemote) {
        client.app.log({ level: "info", message: `[Plannotator] Open in browser: ${url}` });
      }
    },
  });

  const result = await server.waitForDecision();
  await Bun.sleep(1500);
  server.stop();

  // Both exit and approve signal "don't inject feedback" — return null.
  if (result.exit || result.approved) {
    return null;
  }

  return result.feedback || null;
}

export async function handleArchiveCommand(
  event: any,
  deps: CommandDeps
) {
  const { client, htmlContent, getSharingEnabled, getShareBaseUrl, getPasteApiUrl } = deps;

  client.app.log({ level: "info", message: "Opening plan archive..." });

  const server = await startPlannotatorServer({
    plan: "",
    origin: "opencode",
    mode: "archive",
    sharingEnabled: await getSharingEnabled(),
    shareBaseUrl: getShareBaseUrl(),
    pasteApiUrl: getPasteApiUrl(),
    htmlContent,
    onReady: (url, isRemote, port) => {
      handleServerReady(url, isRemote, port);
      if (isRemote) {
        client.app.log({ level: "info", message: `[Plannotator] Open in browser: ${url}` });
      }
    },
  });

  if (server.waitForDone) {
    await server.waitForDone();
  }
  await Bun.sleep(1500);
  server.stop();
}
