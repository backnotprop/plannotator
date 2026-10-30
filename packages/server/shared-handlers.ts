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
import { browserNoneReason, resolveBrowserIntent } from "@plannotator/shared/browser-intent";
import { isLocalOnlyAdvertisedUrl } from "@plannotator/shared/advertised-url";
import { writeUrlQr } from "./qr";
import { validateImagePath, validateUploadExtension, UPLOAD_DIR } from "./image";
import { saveDraft, loadDraft, deleteDraft, getDraftGeneration } from "./draft";
import { CLASSIC_FAVICON_SVG, FAVICON_PNG_BYTES } from "@plannotator/shared/favicon";
import { getServerConfig } from "./config";
import { saveToObsidian, saveToBear, saveToOctarine, saveToNotion } from "./integrations";
import type { ObsidianConfig, BearConfig, OctarineConfig, NotionConfig, IntegrationResult } from "./integrations";
import { listReferenceSkills, readReferenceSkillContent } from "./review-skill-loader";
import { crossOriginRefusalBody } from "@plannotator/shared/request-origin";
import { isSameOriginRequest } from "./request-origin-guard";
import { checkServerSession, serverSessionMismatchBody } from "@plannotator/shared/server-session";
import { localImageContentType, localImageResponseHeaders } from "@plannotator/shared/local-image";

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
  // Every answer carries the sandbox CSP, nosniff and CORP (see
  // @plannotator/shared/local-image): an SVG opened directly must not run
  // script on the session origin.
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
    // If not found and a base directory is provided, try resolving relative to it
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

/**
 * List global agent skills for comment skill references. Used by plan +
 * annotate servers. Takes no client input (fixed roots only) and degrades to an
 * empty catalog on any failure so the composer never breaks.
 */
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

/**
 * Serve a referenced skill's SKILL.md contents for feedback injection
 * (`?name=<skill>`). Used by plan + annotate servers. The name is matched
 * against discovered skills only — it is never used as a path — so traversal
 * and absolute-path inputs answer 404, never a file outside the skill roots.
 */
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

/** Return the shared JSON response for an unmatched API route. */
export function handleApiNotFound(path: string): Response {
  return Response.json({ error: "Not found", path }, { status: 404 });
}

/**
 * Serve the app favicon. Used by all 3 servers (plus goal-setup).
 *
 * Reads the persisted style so a classic user's first painted frame is already
 * classic. Without this the static route always answered Totman and the
 * preference only landed once React mounted, i.e. a visible flash on every load.
 *
 * The route is one URL with two possible payloads, so the response declares its
 * real type and is not cached: the entry HTML's <link rel="icon"> deliberately
 * carries no `type`/`sizes` (see apps/hook/index.html), leaving Content-Type the
 * single source of truth, and a day-long cache would re-paint the old icon after
 * a switch. loadConfig() is a small unmemoized JSON read, once per page load.
 */
export function handleFavicon(): Response {
  if (getServerConfig(null).favicon === "classic") {
    return new Response(CLASSIC_FAVICON_SVG, {
      headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-cache" },
    });
  }
  return new Response(FAVICON_PNG_BYTES, {
    headers: { "Content-Type": "image/png", "Cache-Control": "no-cache" },
  });
}

interface ServerReadyOptions {
  readyFile?: string;
  skipBrowserOpen?: boolean;
  openBrowser?: typeof openBrowserImpl;
  /**
   * Set false to suppress the stderr line(s) this function writes, while
   * still writing the ready file and opening the browser. For hosts that run
   * the server in their own process and share stderr with a TUI renderer
   * (OpenCode's embedded runtime) and already show the URL through their own
   * surface (a toast or a transcript notice). Default true: every CLI start
   * prints the line.
   */
  announce?: boolean;
}

export interface ServerReadyMetadata {
  url: string;
  isRemote: boolean;
  port: number;
  /**
   * What this server shows, in full (absolute path, URL, bundle files,
   * reviewed directory or PR URL), so a host names the right file before any
   * decision. Additive; absent when the CLI did not set it.
   */
  target?: string | string[];
  /**
   * Present only for a session published with `--tailscale` (#2166): `ask`
   * true when "Ask this session" answers the machine owner's tab over the
   * tailnet. A host that asked for a tailnet session reads its absence as a
   * CLI from before the bridge was kept there.
   */
  tailnet?: { ask: boolean };
}

let serverReadyTarget: string | string[] | undefined;
let serverReadyTailnet: { ask: boolean } | undefined;

/** The `tailnet` field the next ready line carries (`--tailscale` sessions only). */
export function setServerReadyTailnet(tailnet: { ask: boolean } | undefined): void {
  serverReadyTailnet = tailnet ? { ask: tailnet.ask } : undefined;
}

/**
 * The full target the next ready line names (`ServerReadyMetadata.target`).
 * The CLI serves one session per process and sets it once it has resolved
 * what it opens, before the server starts.
 */
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

/**
 * Stable prefix of the session URL line written to stderr on every start:
 * `  Plannotator session ready: <url>`.
 *
 * The format is a contract: one line, two leading spaces, this prefix, then
 * the URL last. Agents and host plugins grep it (the OpenCode CLI bridge's
 * stderr filter matches it), so anything else worth saying (port forwarding,
 * a failed browser launch) goes on its own line under it.
 */
export const SESSION_READY_LINE_PREFIX = "Plannotator session ready: ";

/** Announce the session URL, then attempt to open the browser for it. */
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

  // One line, every session, URL last, printed BEFORE the launch: a launcher
  // that never exits (a blocking BROWSER) must not hide it, and a local
  // session whose browser opened fine still needs a way back to a closed tab.
  // The URL appears exactly once; the lines below only add context.
  if (announce) process.stderr.write(`\n  ${SESSION_READY_LINE_PREFIX}${url}\n`);

  // A remote/SSH session can't pop a browser on the user's machine, so say
  // what to do with the URL, independently of whether URL sharing is enabled.
  if (isRemote && announce) {
    // A non-local advertised URL (a tailnet host, a reverse-proxy origin) is
    // directly reachable, so the port-forwarding advice would be wrong.
    if (!isLocalOnlyAdvertisedUrl(url)) {
      process.stderr.write(`  Open it on your device (the URL above).\n`);
      // The URL makes a device hop; a QR skips retyping it (TTY only). A QR
      // of a localhost URL would scan to nowhere, so only render one here.
      writeUrlQr(url);
    } else {
      process.stderr.write(`  Open it on your local machine (forward port ${port} if needed).\n`);
    }
  }

  const skipBrowserOpen = options.skipBrowserOpen ?? process.env.PLANNOTATOR_SKIP_BROWSER_OPEN === "1";
  // PLANNOTATOR_BROWSER=none (or --browser none): open nothing, anywhere, and
  // say so under the URL instead of reporting a failed launch. A host that
  // opens the browser itself (skipBrowserOpen) has nothing to explain.
  const intent = resolveBrowserIntent(process.env);
  if (!skipBrowserOpen && intent.kind === "none") {
    if (announce) process.stderr.write(`  ${browserNoneReason(intent)}\n\n`);
    return;
  }
  if (announce) process.stderr.write("\n");
  if (skipBrowserOpen) return;

  const opened = await (options.openBrowser ?? openBrowserImpl)(url, { isRemote, useGlimpse: true });

  // The URL is already out; say the automatic launch failed (headless box,
  // devcontainer with no display, broken open/xdg-open) so nobody waits on a
  // tab that never appears. Remote sessions were told what to do above.
  if (!opened && !isRemote && announce) {
    process.stderr.write("  Could not open a browser automatically — open the URL above.\n\n");
  }
}

export interface HandleSaveNotesOptions {
  /**
   * This server's stale-tab nonce (packages/core/server-session.ts). A body
   * carrying a different `serverSession` is refused with 409 before anything
   * is written or opened; a body without one is accepted.
   */
  serverSession?: string;
  /** Notion saves run only when this session offers Notion (packages/shared/notion.ts isNotionAvailable). */
  notion?: boolean;
}

/**
 * Save to external note apps (Obsidian, Bear, Octarine, Notion). Used by plan + annotate servers.
 *
 * Writes a file into the vault the body names and opens `bear://` /
 * `octarine://` URLs, so it refuses another site's page (the servers also do
 * this before routing; repeated here so the handler is safe wherever it is
 * mounted) and a stale tab.
 */
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
