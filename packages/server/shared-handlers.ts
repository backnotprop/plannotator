/**
 * Shared route handlers used by plan, review, and annotate servers.
 *
 * Eliminates duplication of /api/image, /api/upload, /api/draft, unmatched API
 * responses, and the server-ready handler across all three server files. Also
 * shares /api/agents for plan + review.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openBrowser as openBrowserImpl } from "./browser";
import { validateImagePath, validateUploadExtension, UPLOAD_DIR } from "./image";
import { saveDraft, loadDraft, deleteDraft, getDraftGeneration } from "./draft";
import { FAVICON_PNG_BYTES } from "@plannotator/shared/favicon";
import { saveToObsidian, saveToBear, saveToOctarine, saveToNotion } from "./integrations";
import type { ObsidianConfig, BearConfig, OctarineConfig, NotionConfig, IntegrationResult } from "./integrations";

function normalizeDraftGeneration(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function readDraftGenerationFromUrl(req: Request): number | undefined {
  const url = new URL(req.url);
  const raw = url.searchParams.get("generation") ?? url.searchParams.get("draftGeneration");
  if (raw === null) return undefined;
  const value = Number(raw);
  return normalizeDraftGeneration(value);
}

export function readDraftGenerationFromBody(body: unknown): number | undefined {
  if (!body || typeof body !== "object") return undefined;
  return normalizeDraftGeneration((body as { draftGeneration?: unknown }).draftGeneration);
}

/** Serve images from local paths or temp uploads. Used by all 3 servers. */
export async function handleImage(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const imagePath = url.searchParams.get("path");
  if (!imagePath) {
    return new Response("Missing path parameter", { status: 400 });
  }
  const validation = validateImagePath(imagePath);
  if (!validation.valid) {
    return new Response(validation.error!, { status: 403 });
  }
  try {
    const file = Bun.file(validation.resolved);
    if (await file.exists()) {
      return new Response(file);
    }
    // If not found and a base directory is provided, try resolving relative to it
    const base = url.searchParams.get("base");
    if (base && !imagePath.startsWith("/")) {
      const { resolve: resolvePath } = await import("path");
      const fromBase = resolvePath(base, imagePath);
      const baseValidation = validateImagePath(fromBase);
      if (baseValidation.valid) {
        const baseFile = Bun.file(baseValidation.resolved);
        if (await baseFile.exists()) {
          return new Response(baseFile);
        }
      }
    }
    return new Response("File not found", { status: 404 });
  } catch {
    return new Response("Failed to read file", { status: 500 });
  }
}

/** Upload image to temp dir, return path. Used by all 3 servers. */
export async function handleUpload(req: Request): Promise<Response> {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File;
    if (!file) {
      return new Response("No file provided", { status: 400 });
    }

    const extResult = validateUploadExtension(file.name);
    if (!extResult.valid) {
      return Response.json({ error: extResult.error }, { status: 400 });
    }
    mkdirSync(UPLOAD_DIR, { recursive: true });
    const tempPath = `${UPLOAD_DIR}/${crypto.randomUUID()}.${extResult.ext}`;

    await Bun.write(tempPath, file);
    return Response.json({ path: tempPath, originalName: file.name });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

/** OpenCode agent client interface (subset of OpenCode SDK) */
export interface OpencodeClient {
  app: {
    agents: (options?: object) => Promise<{
      data?: Array<{ name: string; description?: string; mode: string; hidden?: boolean }>;
    }>;
  };
}

/** List available agents. Used by plan + review servers (OpenCode only). */
export async function handleAgents(opencodeClient?: OpencodeClient): Promise<Response> {
  if (!opencodeClient) {
    return Response.json({ agents: [] });
  }

  try {
    const result = await opencodeClient.app.agents({});
    const agents = (result.data ?? [])
      .filter((a) => a.mode === "primary" && !a.hidden)
      .map((a) => ({ id: a.name, name: a.name, description: a.description }));

    return Response.json({ agents });
  } catch {
    return Response.json({ agents: [], error: "Failed to fetch agents" });
  }
}

/** Save annotation draft. Used by all 3 servers. */
export async function handleDraftSave(req: Request, contentKey: string): Promise<Response> {
  try {
    const body = await req.json();
    saveDraft(contentKey, body);
    return Response.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save draft";
    console.error(`[draft] save failed: ${message}`);
    return Response.json({ error: message }, { status: 500 });
  }
}

/** Load annotation draft. Used by all 3 servers. */
export function handleDraftLoad(contentKey: string): Response {
  const draft = loadDraft(contentKey);
  if (!draft) {
    const draftGeneration = getDraftGeneration(contentKey);
    return Response.json(
      { found: false, ...(draftGeneration !== null ? { draftGeneration } : {}) },
      { status: 404 },
    );
  }
  return Response.json(draft);
}

/** Delete annotation draft. Used by all 3 servers. */
export function handleDraftDelete(contentKey: string, req?: Request): Response {
  deleteDraft(contentKey, req ? readDraftGenerationFromUrl(req) : undefined);
  return Response.json({ ok: true });
}

/** Return the shared JSON response for an unmatched API route. */
export function handleApiNotFound(path: string): Response {
  return Response.json({ error: "Not found", path }, { status: 404 });
}

/** Serve the app favicon. Used by all 3 servers. */
export function handleFavicon(): Response {
  return new Response(FAVICON_PNG_BYTES, {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
  });
}

interface ServerReadyOptions {
  readyFile?: string;
  skipBrowserOpen?: boolean;
  openBrowser?: typeof openBrowserImpl;
}

export interface ServerReadyMetadata {
  url: string;
  isRemote: boolean;
  port: number;
}

export function writeServerReadyMetadata(readyFile: string, metadata: ServerReadyMetadata): void {
  mkdirSync(dirname(readyFile), { recursive: true });
  appendFileSync(readyFile, `${JSON.stringify(metadata)}\n`, "utf8");
}

export function isCodexDesktopHost(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.__CFBundleIdentifier === "com.openai.codex";
}

/** Attempt to open the browser for the session URL. */
export async function handleServerReady(
  url: string,
  isRemote: boolean,
  port: number,
  options: ServerReadyOptions = {},
): Promise<void> {
  const readyFile = options.readyFile ?? process.env.PLANNOTATOR_READY_FILE;
  if (readyFile) {
    try {
      writeServerReadyMetadata(readyFile, { url, isRemote, port });
    } catch (error) {
      if (options.readyFile) throw error;
      // Best effort: host plugins use this side channel to open the browser.
    }
  }

  // A remote/SSH session can't pop a browser on the user's machine, so the
  // session URL must be visible in the terminal — independently of whether URL
  // sharing is enabled. The share link (gated on sharing) is an extra; this
  // reachable URL is the lifeline. Without it, a sharing-disabled remote user
  // saw no URL at all and the agent hung waiting on the review.
  if (isRemote) {
    process.stderr.write(
      `\n  Plannotator session ready — open on your local machine (forward port ${port} if needed):\n  ${url}\n\n`,
    );
  } else if (isCodexDesktopHost()) {
    process.stderr.write(`\n  Plannotator session ready:\n  ${url}\n\n`);
  }

  const skipBrowserOpen = options.skipBrowserOpen ?? process.env.PLANNOTATOR_SKIP_BROWSER_OPEN === "1";
  if (skipBrowserOpen) return;

  const opened = await (options.openBrowser ?? openBrowserImpl)(url, { isRemote, useGlimpse: true });

  // Local fallback lifeline: if the browser couldn't be opened (headless box,
  // devcontainer with no display, broken open/xdg-open), the user otherwise has
  // no URL and the agent hangs at waitForDecision. Remote already printed the
  // URL above; only cover the local case here to avoid a double print.
  if (!opened && !isRemote) {
    process.stderr.write(`\n  Plannotator session ready — open in your browser:\n  ${url}\n\n`);
  }
}

/** Save to external note apps. Used by plan + annotate servers. */
export async function handleSaveNotes(req: Request): Promise<Response> {
  const results: { obsidian?: IntegrationResult; bear?: IntegrationResult; octarine?: IntegrationResult; notion?: IntegrationResult } = {};

  try {
    const body = (await req.json()) as {
      obsidian?: ObsidianConfig;
      bear?: BearConfig;
      octarine?: OctarineConfig;
      notion?: NotionConfig;
    };

    const promises: Promise<void>[] = [];
    if (body.obsidian?.vaultPath && body.obsidian?.plan) {
      promises.push(saveToObsidian(body.obsidian).then(r => { results.obsidian = r; }));
    }
    if (body.bear?.plan) {
      promises.push(saveToBear(body.bear).then(r => { results.bear = r; }));
    }
    if (body.octarine?.plan && body.octarine?.workspace) {
      promises.push(saveToOctarine(body.octarine).then(r => { results.octarine = r; }));
    }
    if (body.notion?.plan && body.notion?.parentPageId) {
      promises.push(saveToNotion(body.notion).then(r => { results.notion = r; }));
    }
    await Promise.allSettled(promises);

    for (const [name, result] of Object.entries(results)) {
      if (!result?.success && result) {
        console.error(`[${name}] Save failed: ${result.error}`);
      }
    }
  } catch (err) {
    console.error(`[Save Notes] Error:`, err);
    return Response.json({ error: "Save failed" }, { status: 500 });
  }

  return Response.json({ ok: true, results });
}
