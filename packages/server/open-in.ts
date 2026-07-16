/**
 * Open-in-App launcher (Bun runtime).
 *
 * Cross-platform "open this file in <app>" helper, modeled on
 * `packages/server/browser.ts` (openBrowser) and `packages/server/ide.ts`
 * (openEditorDiff). Uses argv arrays via `Bun.spawn` — never shell string
 * interpolation — to avoid command injection.
 *
 * The app catalog is the single source of truth at
 * `@plannotator/shared/open-in-apps`. `kind` drives launch semantics:
 *   - file-manager (reveal)  -> reveal the file in the OS file manager
 *   - editor                 -> open the file itself
 *   - terminal               -> open the file's parent directory
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  OPEN_IN_APPS,
  getOpenInApp,
  resolveRevealLabel,
  resolveRevealIcon,
  type OpenInApp,
  type OpenInKind,
  type OpenInPlatform,
} from "@plannotator/shared/open-in-apps";
import { resolveOpenInTarget } from "@plannotator/shared/html-assets-node";
import { isRemoteSession } from "./remote";

export type OpenInLaunchResult = { ok: true } | { ok: false; error: string };

function currentPlatform(): OpenInPlatform {
  switch (process.platform) {
    case "darwin":
      return "mac";
    case "win32":
      return "win";
    default:
      return "linux";
  }
}

/**
 * Run an argv command without a shell. Resolves to a launch result, surfacing
 * ENOENT (app/binary not found) as a friendly error.
 */
async function runArgv(
  cmd: string,
  args: string[],
  friendlyName: string,
  opts?: { cwd?: string },
): Promise<OpenInLaunchResult> {
  try {
    const proc = Bun.spawn([cmd, ...args], {
      stdout: "ignore",
      stderr: "pipe",
      ...(opts?.cwd && { cwd: opts.cwd }),
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      if (/not found|ENOENT/i.test(stderr)) {
        return { ok: false, error: `${friendlyName} not found` };
      }
      return {
        ok: false,
        error: `Failed to open ${friendlyName} (exit ${exitCode})${stderr ? `: ${stderr.trim()}` : ""}`,
      };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT|not found/i.test(msg)) {
      return { ok: false, error: `${friendlyName} not found` };
    }
    return { ok: false, error: msg };
  }
}

/**
 * Spawn a launcher we can't meaningfully await — e.g. Windows `explorer`, which
 * exits non-zero even on success. Returns ok unless the spawn itself throws.
 */
function spawnDetached(
  cmd: string,
  args: string[],
  friendlyName: string,
): Promise<OpenInLaunchResult> {
  try {
    Bun.spawn([cmd, ...args], { stdout: "ignore", stderr: "ignore" });
    return Promise.resolve({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT|not found/i.test(msg)) {
      return Promise.resolve({ ok: false, error: `${friendlyName} not found` });
    }
    return Promise.resolve({ ok: false, error: msg });
  }
}

/**
 * Launch the system-default handler for a path.
 */
function openSystemDefault(target: string): Promise<OpenInLaunchResult> {
  const platform = currentPlatform();
  if (platform === "mac") {
    return runArgv("open", [target], "default app");
  }
  if (platform === "win") {
    // `start` is a cmd builtin; the empty-string title arg avoids the quoted
    // target being treated as a window title.
    return runArgv("cmd", ["/c", "start", "", path.basename(target)], "default app", {
      cwd: path.dirname(target),
    });
  }
  return runArgv("xdg-open", [target], "default app");
}

/**
 * Reveal a file in the OS file manager.
 */
function revealFile(absPath: string): Promise<OpenInLaunchResult> {
  const platform = currentPlatform();
  if (platform === "mac") {
    return runArgv("open", ["-R", absPath], "Finder");
  }
  if (platform === "win") {
    // explorer.exe exits non-zero even on success; launch fire-and-forget.
    return spawnDetached("explorer", [`/select,${absPath}`], "Explorer");
  }
  return runArgv("xdg-open", [path.dirname(absPath)], "file manager");
}

/**
 * Launch an editor/terminal app from the catalog.
 *   - editor   -> open the file itself
 *   - terminal -> open the file's parent directory
 */
function openWithApp(
  app: OpenInApp,
  absPath: string,
): Promise<OpenInLaunchResult> {
  const platform = currentPlatform();
  const target = app.kind === "terminal" ? path.dirname(absPath) : absPath;

  if (platform === "mac") {
    const appName = app.mac?.appName;
    if (!appName) {
      return Promise.resolve({
        ok: false,
        error: `${app.label} is not available on macOS`,
      });
    }
    return runArgv("open", ["-a", appName, target], app.label);
  }

  if (platform === "win") {
    const bin = app.win?.bin;
    if (!bin) {
      return Promise.resolve({
        ok: false,
        error: `${app.label} is not available on Windows`,
      });
    }
    if (app.kind === "terminal") {
      // Open a new console window for the terminal. The directory is passed via
      // cwd (NOT a cmd argument) so a repo-controlled path never reaches cmd's
      // parser; `start` inherits that cwd. bin is a trusted catalog value.
      return runArgv("cmd", ["/c", "start", "", bin], app.label, { cwd: target });
    }
    return runArgv(bin, [target], app.label);
  }

  const bin = app.linux?.bin;
  if (!bin) {
    return Promise.resolve({
      ok: false,
      error: `${app.label} is not available on Linux`,
    });
  }
  return runArgv(bin, [target], app.label);
}

/**
 * Open a file in the given app (by catalog id). An unknown or undefined id
 * falls back to the OS default handler.
 */
export async function openFileInApp(
  absPath: string,
  appId?: string,
): Promise<OpenInLaunchResult> {
  if (!appId) {
    return openSystemDefault(absPath);
  }

  const app = getOpenInApp(appId);
  if (!app) {
    // Unknown id — fall back to system default.
    return openSystemDefault(absPath);
  }

  if (app.kind === "file-manager") {
    return revealFile(absPath);
  }

  return openWithApp(app, absPath);
}

/**
 * Whether a macOS app bundle named `<appName>.app` exists in one of the
 * standard application directories.
 */
function macAppBundleExists(appName: string): boolean {
  const bundle = `${appName}.app`;
  const candidates = [
    path.join("/Applications", bundle),
    path.join(os.homedir(), "Applications", bundle),
    path.join("/System/Applications", bundle),
    // Terminal.app and other built-ins live in the Utilities subfolder.
    path.join("/System/Applications/Utilities", bundle),
  ];
  return candidates.some((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

/**
 * Whether the given catalog app is launchable on this host.
 *   - 'reveal' is always available.
 *   - mac: the `.app` bundle exists (we launch via `open -a "<appName>"`).
 *   - win/linux: its bin resolves on PATH.
 */
function isAppAvailable(app: OpenInApp, platform: OpenInPlatform): boolean {
  if (app.id === "reveal") {
    return true;
  }

  if (platform === "mac") {
    // We launch via `open -a "<appName>"`, so availability must mean the .app
    // bundle is present — a CLI shim on PATH without the bundle would show the
    // app in the menu and then fail to launch.
    const appName = app.mac?.appName;
    return !!appName && macAppBundleExists(appName);
  }

  if (platform === "win") {
    const bin = app.win?.bin;
    return !!bin && !!Bun.which(bin);
  }

  // linux
  const bin = app.linux?.bin;
  return !!bin && !!Bun.which(bin);
}

export interface AvailableOpenInApp {
  id: string;
  label: string;
  kind: OpenInKind;
  icon: string;
}

/**
 * The catalog filtered to apps launchable on this host, in catalog order,
 * with per-platform label/icon resolved for the 'reveal' entry. Always
 * includes 'reveal'.
 */
export function getAvailableOpenInApps(): AvailableOpenInApp[] {
  const platform = currentPlatform();
  const result: AvailableOpenInApp[] = [];

  for (const app of OPEN_IN_APPS) {
    if (!isAppAvailable(app, platform)) continue;

    let label = app.label;
    let icon = app.icon;
    if (app.id === "reveal") {
      label = resolveRevealLabel(platform);
      icon = resolveRevealIcon(platform);
    }

    result.push({ id: app.id, label, kind: app.kind, icon });
  }

  return result;
}

/**
 * GET /api/open-in/apps handler.
 *
 * `available` is false in remote/headless sessions (the UI hides the control
 * entirely). `apps` is the host-filtered catalog (always includes 'reveal');
 * empty when unavailable.
 */
export function handleOpenInApps(): Response {
  if (isRemoteSession()) {
    return Response.json({ available: false, apps: [] });
  }
  return Response.json({ available: true, apps: getAvailableOpenInApps() });
}

export interface HandleOpenInOptions {
  /**
   * Server-supplied resolution root, used INSTEAD of the client-provided
   * `base`. The review server passes `resolveAgentCwd()` here so repo-relative
   * `git diff` paths resolve against the VCS root rather than the launch cwd
   * (which differs when `plannotator review` runs from a subdirectory).
   * When omitted, the handler falls back to the client `base`. May return
   * several roots (annotate passes the session's reference roots).
   */
  resolveRoot?: () => string | string[];
}

/**
 * POST /api/open-in handler. Resolves + containment-checks the target via
 * resolveOpenInTarget (shared), then launches via openFileInApp.
 */
export async function handleOpenIn(
  req: Request,
  options: HandleOpenInOptions = {},
): Promise<Response> {
  if (isRemoteSession()) {
    return Response.json(
      { ok: false, error: "Open in app is unavailable in remote sessions" },
      { status: 400 },
    );
  }

  let body: { filePath?: unknown; base?: unknown; appId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "Invalid request" }, { status: 400 });
  }

  const filePath = typeof body.filePath === "string" ? body.filePath : "";
  if (!filePath) {
    return Response.json({ ok: false, error: "Missing filePath" }, { status: 400 });
  }
  const base = typeof body.base === "string" ? body.base : null;
  const appId = typeof body.appId === "string" ? body.appId : undefined;

  const abs = resolveOpenInTarget(filePath, base, options.resolveRoot);
  if (abs == null) {
    return Response.json({ ok: false, error: "Access denied" }, { status: 403 });
  }

  const result = await openFileInApp(abs, appId);
  // A failed launch is a valid request with the result in the body (ok:false),
  // not a server error — return 200 and let the client read `ok`. Matches Pi.
  return Response.json(result);
}
