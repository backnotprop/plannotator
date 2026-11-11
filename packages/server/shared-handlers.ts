import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openBrowser as openBrowserImpl } from "./browser";
import { browserNoneReason, resolveBrowserIntent } from "@plannotator/shared/browser-intent";
import { isLocalOnlyAdvertisedUrl } from "@plannotator/shared/advertised-url";
import { writeUrlQr } from "./qr";
import { validateImagePath, validateUploadExtension, UPLOAD_DIR } from "./image";
import { saveDraft, loadDraft, deleteDraft, getDraftGeneration } from "./draft";
import { faviconBody, faviconIcoBody } from "@plannotator/shared/favicon";
import { getServerConfig } from "./config";
import { saveToObsidian, saveToBear, saveToOctarine, saveToNotion } from "./integrations";
import type { ObsidianConfig, BearConfig, OctarineConfig, NotionConfig, IntegrationResult } from "./integrations";
import { listReferenceSkills, readReferenceSkillContent } from "./review-skill-loader";
import { crossOriginRefusalBody } from "@plannotator/shared/request-origin";
import { isSameOriginRequest } from "./request-origin-guard";
import { checkServerSession, serverSessionMismatchBody } from "@plannotator/shared/server-session";
import { localImageContentType, localImageResponseHeaders } from "@plannotator/shared/local-image";
import { starAskRoute, starAskService, type StarAskSurface } from "@plannotator/shared/star-ask";

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

export async function handleImage(req: Request): Promise<Response> {
  // Every answer carries the sandbox CSP, nosniff and CORP: an SVG opened directly must not run script on the session origin.
  const text = (body: string, status: number) =>
    new Response(body, { status, headers: localImageResponseHeaders("text/plain; charset=utf-8") });
  const image = (file: ReturnType<typeof Bun.file>, path: string) =>
    new Response(file, { headers: localImageResponseHeaders(localImageContentType(path)) });

  const url = new URL(req.url);
  const imagePath = url.searchParams.get("path");
  if (!imagePath) {
    return text("Missing path parameter", 400);
  }
  const validation = validateImagePath(imagePath);
  if (!validation.valid) {
    return text(validation.error!, 403);
  }
  try {
    const file = Bun.file(validation.resolved);
    if (await file.exists()) {
      return image(file, validation.resolved);
    }
    const base = url.searchParams.get("base");
    if (base && !imagePath.startsWith("/")) {
      const { resolve: resolvePath } = await import("path");
      const fromBase = resolvePath(base, imagePath);
      const baseValidation = validateImagePath(fromBase);
      if (baseValidation.valid) {
        const baseFile = Bun.file(baseValidation.resolved);
        if (await baseFile.exists()) {
          return image(baseFile, baseValidation.resolved);
        }
      }
    }
    return text("File not found", 404);
  } catch {
    return text("Failed to read file", 500);
  }
}

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

export interface OpencodeClient {
  app: {
    agents: (options?: object) => Promise<{
      data?: Array<{ name: string; description?: string; mode: string; hidden?: boolean }>;
    }>;
  };
}

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

export function handleDraftDelete(contentKey: string, req?: Request): Response {
  deleteDraft(contentKey, req ? readDraftGenerationFromUrl(req) : undefined);
  return Response.json({ ok: true });
}

/** Takes no client input (fixed roots only) and degrades to an empty catalog on any failure so the composer never breaks. */
export function handleReferenceSkills(): Response {
  try {
    return Response.json({ skills: listReferenceSkills() });
  } catch (err) {
    console.error(
      `[plannotator] Skill catalog failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return Response.json({ skills: [] });
  }
}

/** The name is matched against discovered skills only, never used as a path, so traversal and absolute paths answer 404. */
export function handleReferenceSkillContent(req: Request): Response {
  try {
    const name = new URL(req.url).searchParams.get("name") ?? "";
    const skill = readReferenceSkillContent(name);
    if (!skill) {
      return Response.json({ error: "Skill not found" }, { status: 404 });
    }
    return Response.json({ skill });
  } catch (err) {
    console.error(
      `[plannotator] Skill content failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return Response.json({ error: "Skill content failed" }, { status: 500 });
  }
}

export function handleApiNotFound(path: string): Response {
  return Response.json({ error: "Not found", path }, { status: 404 });
}

/** Reads the persisted favicon style so the first painted frame shows the person's icon (no flash on load). Not cached: a long cache would re-paint the old icon after a switch. */
export function handleFavicon(pathname = "/favicon.png"): Response {
  const style = getServerConfig(null).favicon;
  const { body, contentType } = pathname === "/favicon.ico" ? faviconIcoBody(style) : faviconBody(style);
  return new Response(body, {
    headers: { "Content-Type": contentType, "Cache-Control": "no-cache" },
  });
}

interface ServerReadyOptions {
  readyFile?: string;
  skipBrowserOpen?: boolean;
  openBrowser?: typeof openBrowserImpl;
  /** false suppresses the stderr line(s) while still writing the ready file and opening the browser, for hosts sharing stderr with a TUI (OpenCode's embedded runtime). */
  announce?: boolean;
}

export interface ServerReadyMetadata {
  url: string;
  isRemote: boolean;
  port: number;
  /** What this server shows, in full, so a host names the right file before any decision. Absent when the CLI did not set it. */
  target?: string | string[];
  /** Present only for a `--tailscale` session; `ask` is true when "Ask this session" answers the owner's tab over the tailnet. */
  tailnet?: { ask: boolean };
}

let serverReadyTarget: string | string[] | undefined;
let serverReadyTailnet: { ask: boolean } | undefined;

export function setServerReadyTailnet(tailnet: { ask: boolean } | undefined): void {
  serverReadyTailnet = tailnet ? { ask: tailnet.ask } : undefined;
}

export function setServerReadyTarget(target: string | readonly string[] | undefined): void {
  if (target === undefined || (typeof target === "string" ? !target.trim() : target.length === 0)) {
    serverReadyTarget = undefined;
    return;
  }
  serverReadyTarget = typeof target === "string" ? target : [...target];
}

export function writeServerReadyMetadata(readyFile: string, metadata: ServerReadyMetadata): void {
  mkdirSync(dirname(readyFile), { recursive: true });
  appendFileSync(readyFile, `${JSON.stringify(metadata)}\n`, "utf8");
}

/** Stable prefix of the session URL line on stderr (`  Plannotator session ready: <url>`). A contract: agents and host plugins grep it, so other messages go on their own lines. */
export const SESSION_READY_LINE_PREFIX = "Plannotator session ready: ";

export async function handleServerReady(
  url: string,
  isRemote: boolean,
  port: number,
  options: ServerReadyOptions = {},
): Promise<void> {
  const readyFile = options.readyFile ?? process.env.PLANNOTATOR_READY_FILE;
  if (readyFile) {
    try {
      writeServerReadyMetadata(readyFile, {
        url,
        isRemote,
        port,
        ...(serverReadyTarget !== undefined && { target: serverReadyTarget }),
        ...(serverReadyTailnet !== undefined && { tailnet: serverReadyTailnet }),
      });
    } catch (error) {
      if (options.readyFile) throw error;
      // Best effort: host plugins use this side channel to open the browser.
    }
  }

  const announce = options.announce ?? true;

  // Printed before the launch: a launcher that never exits (a blocking BROWSER) must not hide the URL. It appears exactly once.
  if (announce) process.stderr.write(`\n  ${SESSION_READY_LINE_PREFIX}${url}\n`);

  if (isRemote && announce) {
    if (!isLocalOnlyAdvertisedUrl(url)) {
      process.stderr.write(`  Open it on your device (the URL above).\n`);
      // A QR of a localhost URL would scan to nowhere, so only render one for a non-local URL (TTY only).
      writeUrlQr(url);
    } else {
      process.stderr.write(`  Open it on your local machine (forward port ${port} if needed).\n`);
    }
  }

  const skipBrowserOpen = options.skipBrowserOpen ?? process.env.PLANNOTATOR_SKIP_BROWSER_OPEN === "1";
  const intent = resolveBrowserIntent(process.env);
  if (!skipBrowserOpen && intent.kind === "none") {
    if (announce) process.stderr.write(`  ${browserNoneReason(intent)}\n\n`);
    return;
  }
  if (announce) process.stderr.write("\n");
  if (skipBrowserOpen) return;

  const opened = await (options.openBrowser ?? openBrowserImpl)(url, { isRemote, useGlimpse: true });

  if (!opened && !isRemote && announce) {
    process.stderr.write("  Could not open a browser automatically — open the URL above.\n\n");
  }
}

export interface HandleSaveNotesOptions {
  /** This server's stale-tab nonce: a different `serverSession` is refused with 409 before anything is written or opened. */
  serverSession?: string;
  notion?: boolean;
}

/** Writes into the vault the body names and opens `bear://`/`octarine://` URLs, so it refuses another site's page and a stale tab itself (safe wherever mounted). */
export async function handleSaveNotes(req: Request, options: HandleSaveNotesOptions = {}): Promise<Response> {
  if (!isSameOriginRequest(req)) {
    return Response.json(crossOriginRefusalBody(), { status: 403 });
  }

  const results: { obsidian?: IntegrationResult; bear?: IntegrationResult; octarine?: IntegrationResult; notion?: IntegrationResult } = {};

  try {
    const body = (await req.json()) as {
      obsidian?: ObsidianConfig;
      bear?: BearConfig;
      octarine?: OctarineConfig;
      notion?: NotionConfig;
    };

    if (options.serverSession !== undefined && checkServerSession(body, options.serverSession) === "mismatch") {
      return Response.json(serverSessionMismatchBody(), { status: 409 });
    }

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
    if (options.notion && body.notion?.plan && body.notion?.parentPageId) {
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

/** In remote mode the ask never shows: gh there is the server machine's login, not the person's. */
export async function handleStarAsk(req: Request, url: URL, surface: StarAskSurface, options: { remote: boolean }): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/star-ask/")) return null;
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : undefined;
  const answered = await starAskRoute(starAskService(), surface, req.method, url.pathname, body, { remote: options.remote });
  return answered ? Response.json(answered.body, { status: answered.status }) : null;
}
