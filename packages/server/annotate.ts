/**
 * Plannotator Annotation Server
 *
 * Simplified server for annotating arbitrary markdown files.
 * Unlike the plan server, this doesn't handle hook decisions - it just outputs feedback.
 *
 * Usage: plannotator annotate <file.md>
 */

import { mkdirSync } from "fs";
import { isRemoteSession, getServerPort } from "./remote";
import { openBrowser } from "./browser";
import {
  injectValidationMarkers,
  extractValidationMarkers,
  type Annotation,
} from "@plannotator/core";

// --- Types ---

export interface AnnotateServerOptions {
  /** The markdown content to annotate */
  markdown: string;
  /** Absolute path to the source file */
  filePath: string;
  /** Origin identifier (e.g., "claude-code") */
  origin: string;
  /** HTML content to serve for the UI */
  htmlContent: string;
  /** Whether URL sharing is enabled (default: true) */
  sharingEnabled?: boolean;
  /** Called when server starts with the URL, remote status, and port */
  onReady?: (url: string, isRemote: boolean, port: number) => void;
}

export interface AnnotateServerResult {
  /** The port the server is running on */
  port: number;
  /** The full URL to access the server */
  url: string;
  /** Whether running in remote mode */
  isRemote: boolean;
  /** Wait for user to submit feedback */
  waitForDecision: () => Promise<{ feedback: string }>;
  /** Stop the server */
  stop: () => void;
}

// --- Server Implementation ---

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 500;

/**
 * Start the Annotation server
 *
 * Handles:
 * - Remote detection and port configuration
 * - API routes for annotation mode
 * - Port conflict retries
 */
export async function startAnnotateServer(
  options: AnnotateServerOptions
): Promise<AnnotateServerResult> {
  const {
    markdown,
    filePath,
    origin,
    htmlContent,
    sharingEnabled = true,
    onReady,
  } = options;

  const isRemote = isRemoteSession();
  const configuredPort = getServerPort();

  // Decision promise - resolves when user submits feedback
  let resolveDecision: (result: { feedback: string }) => void;
  const decisionPromise = new Promise<{ feedback: string }>((resolve) => {
    resolveDecision = resolve;
  });

  // Start server with retry logic
  let server: ReturnType<typeof Bun.serve> | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      server = Bun.serve({
        port: configuredPort,

        async fetch(req) {
          const url = new URL(req.url);

          // API: Get markdown content (same endpoint as plan for UI compatibility)
          if (url.pathname === "/api/plan") {
            // Extract existing validation markers from the markdown
            const existingMarkers = extractValidationMarkers(markdown);

            return Response.json({
              plan: markdown,
              origin,
              filePath,
              mode: "annotate",
              sharingEnabled,
              existingMarkers,
            });
          }

          // API: Serve images (local paths or temp uploads)
          if (url.pathname === "/api/image") {
            const imagePath = url.searchParams.get("path");
            if (!imagePath) {
              return new Response("Missing path parameter", { status: 400 });
            }
            try {
              const file = Bun.file(imagePath);
              if (!(await file.exists())) {
                return new Response("File not found", { status: 404 });
              }
              return new Response(file);
            } catch {
              return new Response("Failed to read file", { status: 500 });
            }
          }

          // API: Upload image -> save to temp -> return path
          if (url.pathname === "/api/upload" && req.method === "POST") {
            try {
              const formData = await req.formData();
              const file = formData.get("file") as File;
              if (!file) {
                return new Response("No file provided", { status: 400 });
              }

              const ext = file.name.split(".").pop() || "png";
              const tempDir = "/tmp/plannotator";
              mkdirSync(tempDir, { recursive: true });
              const tempPath = `${tempDir}/${crypto.randomUUID()}.${ext}`;

              await Bun.write(tempPath, file);
              return Response.json({ path: tempPath });
            } catch (err) {
              const message =
                err instanceof Error ? err.message : "Upload failed";
              return Response.json({ error: message }, { status: 500 });
            }
          }

          // API: Save validation markers to source file
          if (url.pathname === "/api/save-markers" && req.method === "POST") {
            try {
              const body = (await req.json()) as { annotations?: Annotation[] };
              const annotations = body.annotations || [];

              // Inject validation markers into the markdown
              const result = injectValidationMarkers(markdown, annotations);

              if (result.markersAdded === 0) {
                return Response.json({
                  success: true,
                  markersAdded: 0,
                  message: "No validation markers to add",
                });
              }

              // Write the modified markdown back to the source file
              await Bun.write(filePath, result.markdown);

              return Response.json({
                success: true,
                markersAdded: result.markersAdded,
                markers: result.markers,
                message: `Added ${result.markersAdded} validation marker(s) to ${filePath}`,
              });
            } catch (err) {
              const message =
                err instanceof Error ? err.message : "Failed to save markers";
              return Response.json({ success: false, error: message }, { status: 500 });
            }
          }

          // API: Submit feedback (annotation mode endpoint)
          if (url.pathname === "/api/feedback" && req.method === "POST") {
            let feedback = "";
            try {
              const body = (await req.json()) as { feedback?: string };
              feedback = body.feedback || "";
            } catch {
              // Empty feedback
            }

            resolveDecision({ feedback });
            return Response.json({ ok: true });
          }

          // API: Also handle /api/deny as feedback submission (UI compatibility)
          if (url.pathname === "/api/deny" && req.method === "POST") {
            let feedback = "";
            try {
              const body = (await req.json()) as { feedback?: string };
              feedback = body.feedback || "";
            } catch {
              // Empty feedback
            }

            resolveDecision({ feedback });
            return Response.json({ ok: true });
          }

          // Serve embedded HTML for all other routes (SPA)
          return new Response(htmlContent, {
            headers: { "Content-Type": "text/html" },
          });
        },
      });

      break; // Success, exit retry loop
    } catch (err: unknown) {
      const isAddressInUse =
        err instanceof Error && err.message.includes("EADDRINUSE");

      if (isAddressInUse && attempt < MAX_RETRIES) {
        await Bun.sleep(RETRY_DELAY_MS);
        continue;
      }

      if (isAddressInUse) {
        const hint = isRemote
          ? " (set PLANNOTATOR_PORT to use different port)"
          : "";
        throw new Error(
          `Port ${configuredPort} in use after ${MAX_RETRIES} retries${hint}`
        );
      }

      throw err;
    }
  }

  if (!server) {
    throw new Error("Failed to start server");
  }

  const serverUrl = `http://localhost:${server.port}`;

  // Notify caller that server is ready
  if (onReady) {
    onReady(serverUrl, isRemote, server.port);
  }

  return {
    port: server.port,
    url: serverUrl,
    isRemote,
    waitForDecision: () => decisionPromise,
    stop: () => server.stop(),
  };
}
