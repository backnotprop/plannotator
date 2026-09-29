/**
 * `plannotator mcp` — stdio MCP server for the Codex plugin.
 *
 * Wires the real annotate pipeline (target resolution, annotate server,
 * browser open, remote share link) into the `annotate` tool. The flow per
 * call mirrors the non-gated plaintext `plannotator annotate` branch in
 * index.ts; only the output channel differs (a tool result instead of
 * stdout, which belongs to the MCP protocol here).
 */

import path from "path";
import {
  startAnnotateServer,
  handleAnnotateServerReady,
  isRemoteSession,
} from "@plannotator/server/annotate";
import { writeRemoteShareLink } from "@plannotator/server/share-url";
import { inlineHtmlLocalAssets } from "@plannotator/server/html-assets";
import { registerSession, unregisterSession } from "@plannotator/server/sessions";
import { detectProjectName } from "@plannotator/server/project";
import { hostnameOrFallback } from "@plannotator/shared/project";
import { LIVE_APP_REMOTE_MESSAGE } from "@plannotator/shared/live-probe";
import type { Origin } from "@plannotator/shared/agents";
import {
  ANNOTATION_HIGHLIGHT_CSS,
  BRIDGE_SCRIPT,
  LIVE_BRIDGE_BOOTSTRAP,
} from "@plannotator/ui/components/html-viewer/bridge-script";
import { resolveAnnotateTarget } from "./annotate-resolution";
import {
  AnnotateSessionRegistry,
  createAnnotateResources,
  createAnnotateTools,
  MCP_SERVER_INSTRUCTIONS,
  type AnnotateToolDeps,
} from "./mcp-annotate";
import { createMcpServer, runStdioMcpServer } from "./mcp-protocol";

export interface McpCommandConfig {
  htmlContent: string;
  origin: Origin;
  version: string;
  sharingEnabled: boolean;
  shareBaseUrl?: string;
  pasteApiUrl?: string;
}

export function createRealAnnotateDeps(config: McpCommandConfig): AnnotateToolDeps {
  return {
    defaultCwd: () => process.env.PLANNOTATOR_CWD || process.cwd(),
    isRemote: () => isRemoteSession(),
    liveAppRemoteMessage: LIVE_APP_REMOTE_MESSAGE,
    settleAfterDecision: () => Bun.sleep(1500),
    resolveTarget: ({ rawFilePath, projectRoot, noJina, renderMarkdown, log }) =>
      resolveAnnotateTarget({ rawFilePath, projectRoot, noJina, renderMarkdown, log }),
    startSession: async (resolution, { gate, markdown: renderMarkdown, projectRoot, onReady }) => {
      const {
        markdown,
        rawHtml,
        absolutePath,
        folderPath,
        annotateMode,
        sourceInfo,
        sourceConverted,
        isUrl,
        liveApp,
      } = resolution;
      const project = (await detectProjectName()) ?? "_unknown";
      const server = await startAnnotateServer({
        markdown,
        filePath: absolutePath,
        origin: config.origin,
        mode: liveApp ? "annotate-app" : annotateMode,
        liveApp: liveApp
          ? {
              targetUrl: absolutePath,
              bridgeScript: BRIDGE_SCRIPT,
              bridgeBootstrap: LIVE_BRIDGE_BOOTSTRAP,
              annotationCss: ANNOTATION_HIGHLIGHT_CSS,
            }
          : undefined,
        folderPath,
        sourceInfo,
        sourceConverted,
        sharingEnabled: config.sharingEnabled,
        shareBaseUrl: config.shareBaseUrl,
        pasteApiUrl: config.pasteApiUrl,
        gate,
        // Plaintext parity: approve-with-notes and the abandoned-tab lease are
        // only offered to structured `--gate --json` callers today.
        approvalNotesSupported: false,
        clientLeaseSupported: false,
        rawHtml,
        renderHtml: !!rawHtml,
        convertHtml: renderMarkdown,
        agentCwd: projectRoot,
        project,
        htmlContent: config.htmlContent,
        onReady: async (url, isRemote, port) => {
          // Browser open + the stderr URL lines (remote and Codex desktop).
          await handleAnnotateServerReady(url, isRemote, port);
          onReady(url, isRemote);
          if (isRemote && config.sharingEnabled) {
            if (rawHtml) {
              await writeRemoteShareLink("", config.shareBaseUrl, "annotate", "HTML document only", {
                rawHtml: inlineHtmlLocalAssets(rawHtml, absolutePath),
                pasteApiUrl: config.pasteApiUrl,
              }).catch(() => {});
            } else if (markdown) {
              await writeRemoteShareLink(markdown, config.shareBaseUrl, "annotate", "document only").catch(() => {});
            }
          }
        },
      });
      registerSession({
        pid: process.pid,
        port: server.port,
        url: server.url,
        mode: "annotate",
        project,
        startedAt: new Date().toISOString(),
        label: folderPath
          ? `annotate-${path.basename(folderPath)}`
          : `annotate-${isUrl ? hostnameOrFallback(absolutePath) : path.basename(absolutePath)}`,
      });
      return {
        url: server.url,
        isRemote: server.isRemote,
        waitForDecision: server.waitForDecision,
        stop: () => {
          // Force-close: this process outlives the session, so the browser's
          // open SSE stream must not keep a socket and heartbeat timer alive.
          server.stop(true);
          unregisterSession();
        },
      };
    },
  };
}

export async function runMcpCommand(config: McpCommandConfig): Promise<never> {
  const deps = createRealAnnotateDeps(config);
  const registry = new AnnotateSessionRegistry();
  process.stderr.write(
    `[plannotator mcp] ready (cwd: ${deps.defaultCwd()}${isRemoteSession() ? ", remote mode" : ""})\n`,
  );
  await runStdioMcpServer((send) =>
    createMcpServer({
      name: "plannotator",
      title: "Plannotator",
      version: config.version,
      instructions: MCP_SERVER_INSTRUCTIONS,
      tools: createAnnotateTools(deps, registry),
      resources: createAnnotateResources(),
      send,
    }),
  );
  unregisterSession();
  process.exit(0);
}
