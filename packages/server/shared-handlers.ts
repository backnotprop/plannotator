/**
 * Shared route handlers used by plan, review, and annotate servers.
 *
 * Eliminates duplication of /api/image, /api/upload, /api/draft, and the
 * server-ready handler across all three server files. Also shares /api/agents
 * for plan + review.
 */

import { mkdirSync } from "fs";
import { openBrowser } from "./browser";
import { validateImagePath, validateUploadExtension, UPLOAD_DIR } from "./image";
import { saveDraft, loadDraft, deleteDraft } from "./draft";

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
    return Response.json({ found: false }, { status: 404 });
  }
  return Response.json(draft);
}

/** Delete annotation draft. Used by all 3 servers. */
export function handleDraftDelete(contentKey: string): Response {
  deleteDraft(contentKey);
  return Response.json({ ok: true });
}

/** Open browser for local sessions or when a custom handler (e.g. VS Code extension) is configured. */
export async function handleServerReady(
  url: string,
  isRemote: boolean,
  _port: number,
): Promise<void> {
  if (!isRemote || process.env.PLANNOTATOR_BROWSER) {
    await openBrowser(url);
  }
}
