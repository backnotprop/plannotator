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
import { getGitContext, runGitDiffWithContext } from "@plannotator/server/git";
import { parsePRUrl, checkAuth, fetchPR, getCliName, getMRLabel, getMRNumberLabel, getDisplayRepo } from "@plannotator/server/pr";
import { resolveMarkdownFile } from "@plannotator/server/resolve-file";

/** Shared dependencies injected by the plugin */
export interface CommandDeps {
  client: any;
  htmlContent: string;
  reviewHtmlContent: string;
  getSharingEnabled: () => Promise<boolean>;
  getShareBaseUrl: () => string | undefined;
  directory?: string;
}

export async function handleReviewCommand(
  event: any,
  deps: CommandDeps
) {
  const { client, reviewHtmlContent, getSharingEnabled, getShareBaseUrl, directory } = deps;

  // @ts-ignore - Event properties contain arguments
  const urlArg: string = event.properties?.arguments || "";
  const isPRMode = urlArg?.startsWith("http://") || urlArg?.startsWith("https://");

  let rawPatch: string;
  let gitRef: string;
  let diffError: string | undefined;
  let gitContext: Awaited<ReturnType<typeof getGitContext>> | undefined;
  let prMetadata: Awaited<ReturnType<typeof fetchPR>>["metadata"] | undefined;

  if (isPRMode) {
    const prRef = parsePRUrl(urlArg);
    if (!prRef) {
      client.app.log({ level: "error", message: `Invalid PR/MR URL: ${urlArg}` });
      return;
    }

    client.app.log({ level: "info", message: `Fetching ${getMRLabel(prRef)} ${getMRNumberLabel(prRef)} from ${getDisplayRepo(prRef)}...` });

    try {
      await checkAuth(prRef);
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

    gitContext = await getGitContext(directory);
    const diffResult = await runGitDiffWithContext("uncommitted", gitContext);
    rawPatch = diffResult.patch;
    gitRef = diffResult.label;
    diffError = diffResult.error;
  }

  const server = await startReviewServer({
    rawPatch,
    gitRef,
    error: diffError,
    origin: "opencode",
    diffType: isPRMode ? undefined : "uncommitted",
    gitContext,
    prMetadata,
    sharingEnabled: await getSharingEnabled(),
    shareBaseUrl: getShareBaseUrl(),
    htmlContent: reviewHtmlContent,
    opencodeClient: client,
    onReady: handleReviewServerReady,
  });

  const result = await server.waitForDecision();
  await Bun.sleep(1500);
  server.stop();

  if (result.feedback) {
    // @ts-ignore - Event properties contain sessionID
    const sessionId = event.properties?.sessionID;

    if (sessionId) {
      const shouldSwitchAgent = result.agentSwitch && result.agentSwitch !== "disabled";
      const targetAgent = result.agentSwitch || "build";

      const message = result.approved
        ? "# Code Review\n\nCode review completed — no changes requested."
        : isPRMode
          ? result.feedback
          : `# Code Review Feedback\n\n${result.feedback}\n\nPlease address this feedback.`;

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
  const { client, htmlContent, getSharingEnabled, getShareBaseUrl } = deps;

  // @ts-ignore - Event properties contain arguments
  const filePath = event.properties?.arguments || event.arguments || "";

  if (!filePath) {
    client.app.log({ level: "error", message: "Usage: /plannotator-annotate <file.md>" });
    return;
  }

  client.app.log({ level: "info", message: `Opening annotation UI for ${filePath}...` });

  const projectRoot = process.cwd();
  const resolved = await resolveMarkdownFile(filePath, projectRoot);

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

  const absolutePath = resolved.path;
  client.app.log({ level: "info", message: `Resolved: ${absolutePath}` });
  const markdown = await Bun.file(absolutePath).text();

  const server = await startAnnotateServer({
    markdown,
    filePath: absolutePath,
    origin: "opencode",
    sharingEnabled: await getSharingEnabled(),
    shareBaseUrl: getShareBaseUrl(),
    htmlContent,
    onReady: handleAnnotateServerReady,
  });

  const result = await server.waitForDecision();
  await Bun.sleep(1500);
  server.stop();

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
              text: `# Markdown Annotations\n\nFile: ${absolutePath}\n\n${result.feedback}\n\nPlease address the annotation feedback above.`,
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
  const { client, htmlContent, getSharingEnabled, getShareBaseUrl } = deps;

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
    htmlContent,
    onReady: handleAnnotateServerReady,
  });

  const result = await server.waitForDecision();
  await Bun.sleep(1500);
  server.stop();

  return result.feedback || null;
}
