/**
 * Command Handlers for OpenCode Plugin
 *
 * Handles /plannotator-review, /plannotator-annotate, /plannotator-last,
 * and /plannotator-archive slash commands. Extracted from the event hook
 * for modularity.
 */

import {
  getReviewApprovedPrompt,
  getReviewDeniedSuffix,
  getAnnotateFileFeedbackPrompt,
} from "@plannotator/shared/prompts";
import { parseAnnotateArgs } from "@plannotator/shared/annotate-args";
import { parseReviewArgs } from "@plannotator/shared/review-args";
import type { PluginAgentInfo, PluginFeature } from "@plannotator/shared/plugin-protocol";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CommandRunOptions,
  type EnsurePlannotatorBinaryResult,
  ensurePlannotatorBinary,
  findPlannotatorSourceRoot,
  runPluginAnnotate,
  runPluginArchive,
  runPluginReview,
} from "./binary-client";

/** Shared dependencies injected by the plugin */
interface OpenCodeCommandEvent {
  arguments?: string;
  properties?: {
    arguments?: string;
    sessionID?: string;
  };
}

interface OpenCodeMessagePart {
  type: string;
  text?: string;
}

interface OpenCodeMessage {
  info: {
    role: string;
  };
  parts: OpenCodeMessagePart[];
}

interface OpenCodeClient {
  app: {
    log: (entry: { level: "error" | "info"; message: string }) => void;
    agents: (options?: { query?: { directory?: string } }) => Promise<{ data?: PluginAgentInfo[] }>;
  };
  session: {
    prompt: (request: {
      path: { id: string };
      body: {
        agent?: string;
        parts: Array<{ type: "text"; text: string }>;
      };
    }) => Promise<unknown>;
    messages: (request: { path: { id: string } }) => Promise<{ data?: OpenCodeMessage[] }>;
  };
}

export interface CommandDeps {
  client: OpenCodeClient;
  getSharingEnabled: () => Promise<boolean>;
  getShareBaseUrl: () => string | undefined;
  getPasteApiUrl: () => string | undefined;
  directory?: string;
  binaryClient?: {
    ensurePlannotatorBinary?: typeof ensurePlannotatorBinary;
    runPluginAnnotate?: typeof runPluginAnnotate;
    runPluginArchive?: typeof runPluginArchive;
    runPluginReview?: typeof runPluginReview;
  };
}

function logBinaryError(client: OpenCodeClient, message: string): void {
  client.app.log({ level: "error", message: `[Plannotator] ${message}` });
}

function logSessionReady(client: OpenCodeClient, url: string): void {
  client.app.log({ level: "info", message: `[Plannotator] Open in browser: ${url}` });
}

function sessionReadyOptions(client: OpenCodeClient): CommandRunOptions {
  return {
    onSession: (session) => logSessionReady(client, session.url),
  };
}

function ensureBinaryForCommand(
  client: OpenCodeClient,
  binaryClient?: CommandDeps["binaryClient"],
  requiredFeatures?: readonly PluginFeature[],
): EnsurePlannotatorBinaryResult {
  const binary = (binaryClient?.ensurePlannotatorBinary ?? ensurePlannotatorBinary)({
    requiredFeatures,
    sourceRoot: findPlannotatorSourceRoot(dirname(fileURLToPath(import.meta.url))),
  });
  if (!binary.ok) logBinaryError(client, binary.message);
  return binary;
}

export async function loadAvailableAgents(client: OpenCodeClient, directory?: string): Promise<PluginAgentInfo[] | undefined> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await client.app.agents({
        query: { directory },
      });
      return response.data ?? undefined;
    } catch (err) {
      lastError = err;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  client.app.log({
    level: "info",
    message: `[Plannotator] OpenCode agent list unavailable; agent switching is disabled for this session.${lastError instanceof Error ? ` ${lastError.message}` : ""}`,
  });
  return undefined;
}

export async function handleReviewCommand(
  event: OpenCodeCommandEvent,
  deps: CommandDeps
) {
  const { client, getSharingEnabled, getShareBaseUrl, getPasteApiUrl, directory, binaryClient } = deps;

  const rawArgs = event.properties?.arguments || "";
  const reviewArgs = parseReviewArgs(rawArgs);
  const isPRMode = reviewArgs.prUrl !== undefined;

  client.app.log({ level: "info", message: isPRMode ? "Opening PR review UI..." : "Opening code review UI..." });

  const binary = ensureBinaryForCommand(client, binaryClient, ["code-review"]);
  if (!binary.ok) return;

  const availableAgents = await loadAvailableAgents(client, directory);
  const response = await (binaryClient?.runPluginReview ?? runPluginReview)(binary.path, {
    origin: "opencode",
    cwd: directory,
    args: rawArgs,
    sharingEnabled: await getSharingEnabled(),
    shareBaseUrl: getShareBaseUrl(),
    pasteApiUrl: getPasteApiUrl(),
    availableAgents,
  }, undefined, sessionReadyOptions(client));

  if (!response.ok) {
    logBinaryError(client, response.error.message);
    return;
  }

  const result = response.result;

  if (result.exit) {
    return;
  }

  if (result.feedback) {
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
  event: OpenCodeCommandEvent,
  deps: CommandDeps
) {
  const { client, getSharingEnabled, getShareBaseUrl, getPasteApiUrl, directory, binaryClient } = deps;

  const rawArgs = event.properties?.arguments || event.arguments || "";
  const { filePath } = parseAnnotateArgs(rawArgs);

  if (!filePath) {
    client.app.log({ level: "error", message: "Usage: /plannotator-annotate <file.md | file.html | https://... | folder/> [--gate] [--json]" });
    return;
  }

  client.app.log({ level: "info", message: `Opening annotation UI for ${filePath}...` });

  const binary = ensureBinaryForCommand(client, binaryClient, ["annotate"]);
  if (!binary.ok) return;

  const response = await (binaryClient?.runPluginAnnotate ?? runPluginAnnotate)(binary.path, {
    origin: "opencode",
    cwd: directory,
    args: rawArgs,
    sharingEnabled: await getSharingEnabled(),
    shareBaseUrl: getShareBaseUrl(),
    pasteApiUrl: getPasteApiUrl(),
  }, undefined, sessionReadyOptions(client));

  if (!response.ok) {
    logBinaryError(client, response.error.message);
    return;
  }

  const result = response.result;

  // Both exit and approve are "no-op for the agent" — skip session injection.
  if (result.exit || result.approved) {
    return;
  }

  if (result.feedback) {
    const sessionId = event.properties?.sessionID;

    if (sessionId) {
      try {
        await client.session.prompt({
          path: { id: sessionId },
          body: {
            parts: [{
              type: "text",
              text: getAnnotateFileFeedbackPrompt("opencode", undefined, {
                fileHeader: result.mode === "annotate-folder" ? "Folder" : "File",
                filePath: result.filePath ?? filePath,
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
  event: OpenCodeCommandEvent,
  deps: CommandDeps
): Promise<string | null> {
  const { client, getSharingEnabled, getShareBaseUrl, getPasteApiUrl, directory, binaryClient } = deps;

  const rawArgs = event.properties?.arguments || event.arguments || "";
  // #570: support --gate on /plannotator-last (Stop-hook review-gate pattern).
  const { gate } = parseAnnotateArgs(rawArgs);

  const sessionId = event.properties?.sessionID;
  if (!sessionId) {
    client.app.log({ level: "error", message: "No active session." });
    return null;
  }

  // Fetch messages from session
  let messagesResponse: Awaited<ReturnType<OpenCodeClient["session"]["messages"]>>;
  try {
    messagesResponse = await client.session.messages({
      path: { id: sessionId },
    });
  } catch (err) {
    client.app.log({
      level: "error",
      message: `[Plannotator] Could not read the current session messages.${err instanceof Error ? ` ${err.message}` : ""}`,
    });
    return null;
  }
  const messages = messagesResponse.data;

  // Walk backward, find last assistant message with text
  let lastText: string | null = null;
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.info.role === "assistant") {
        const textParts = msg.parts
          .filter((p) => p.type === "text" && p.text?.trim())
          .map((p) => p.text!);
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

  const binary = ensureBinaryForCommand(client, binaryClient, ["annotate-last"]);
  if (!binary.ok) return null;

  const response = await (binaryClient?.runPluginAnnotate ?? runPluginAnnotate)(binary.path, {
    markdown: lastText,
    filePath: "last-message",
    origin: "opencode",
    cwd: directory,
    mode: "annotate-last",
    sharingEnabled: await getSharingEnabled(),
    shareBaseUrl: getShareBaseUrl(),
    pasteApiUrl: getPasteApiUrl(),
    gate,
  }, undefined, sessionReadyOptions(client));

  if (!response.ok) {
    logBinaryError(client, response.error.message);
    return null;
  }

  const result = response.result;

  // Both exit and approve signal "don't inject feedback" — return null.
  if (result.exit || result.approved) {
    return null;
  }

  return result.feedback || null;
}

export async function handleArchiveCommand(
  _event: OpenCodeCommandEvent,
  deps: CommandDeps
) {
  const { client, getSharingEnabled, getShareBaseUrl, getPasteApiUrl, directory, binaryClient } = deps;

  client.app.log({ level: "info", message: "Opening plan archive..." });

  const binary = ensureBinaryForCommand(client, binaryClient, ["archive"]);
  if (!binary.ok) return;

  const response = await (binaryClient?.runPluginArchive ?? runPluginArchive)(binary.path, {
    origin: "opencode",
    cwd: directory,
    sharingEnabled: await getSharingEnabled(),
    shareBaseUrl: getShareBaseUrl(),
    pasteApiUrl: getPasteApiUrl(),
  }, undefined, sessionReadyOptions(client));

  if (!response.ok) {
    logBinaryError(client, response.error.message);
  }
}
