/**
 * Open-in-App launcher (Bun runtime).
 *
 * Cross-platform "open this file in <app>" helper, modeled on
 * `packages/server/browser.ts` (openBrowser) and `packages/server/ide.ts`
 * (openEditorDiff). Uses argv arrays, never shell string interpolation, to
 * avoid command injection.
 *
 * Launches are a side concern of the review session, never part of it: each
 * launcher is spawned detached (its own process group) and the request only
 * waits a short grace for instant failures. See runArgv.
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
import { spawn } from "node:child_process";
import {
  OPEN_IN_APPS,
  checkOpenInAppId,
  resolveRevealLabel,
  resolveRevealIcon,
  type OpenInApp,
  type OpenInKind,
  type OpenInPlatform,
} from "@plannotator/shared/open-in-apps";
import { resolveOpenInTarget } from "@plannotator/shared/html-assets-node";
import { isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";
import { checkServerSession, serverSessionMismatchBody } from "@plannotator/shared/server-session";
import { isRemoteSession } from "./remote";

export type OpenInLaunchResult = { ok: true } | { ok: false; error: string };

/** The catalog's name for this host's platform. */
export function currentPlatform(): OpenInPlatform {
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
 * How long a launch may take to fail before we call it launched (ms). Instant
 * failures (missing binary, "Unable to find application") land well inside
 * this window; anything still running after it is a successful launch that we
 * stop waiting on.
 */
const LAUNCH_GRACE_MS = 2000;

/** Cap on captured stderr; the stream keeps draining beyond it. */
const LAUNCH_STDERR_CAP_BYTES = 8192;

/**
 * Run an argv command without a shell. Resolves to a launch result, surfacing
 * ENOENT (app/binary not found) as a friendly error.
 *
 * The child is spawned DETACHED (its own process group) so an editor
 * cold-started by a launcher CLI can never be taken down by a signal aimed at
 * this server's group (agent runtimes cancelling the session, terminal close).
 * The wait is BOUNDED: a launcher CLI that stays attached to the app it
 * started must not hold the HTTP request (and the UI button) hostage until
 * the app quits. stderr is drained from spawn time so a chatty child can
 * never fill the pipe and deadlock inside the grace window.
 */
function runArgv(
  cmd: string,
  args: string[],
  friendlyName: string,
  opts?: { cwd?: string },
): Promise<OpenInLaunchResult> {
  return new Promise((resolve) => {
    const failure = (msg: string): OpenInLaunchResult =>
      /ENOENT|not found/i.test(msg)
        ? { ok: false, error: `${friendlyName} not found` }
        : { ok: false, error: msg };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
        ...(opts?.cwd && { cwd: opts.cwd }),
      });
    } catch (err) {
      resolve(failure(err instanceof Error ? err.message : String(err)));
      return;
    }

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < LAUNCH_STDERR_CAP_BYTES) stderr += chunk.toString();
    });

    let settled = false;
    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null =
      null;
    const finish = (result: OpenInLaunchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };

    // Same failure shape as before: friendly not-found, else exit + stderr.
    const concludeExit = () => {
      if (!exitInfo) return;
      if (/not found|ENOENT/i.test(stderr)) {
        finish({ ok: false, error: `${friendlyName} not found` });
        return;
      }
      const status = exitInfo.code ?? exitInfo.signal ?? "unknown";
      finish({
        ok: false,
        error: `Failed to open ${friendlyName} (exit ${status})${stderr ? `: ${stderr.trim()}` : ""}`,
      });
    };

    // Still running at the deadline: it launched. A failure observed just
    // before the deadline still reports as a failure.
    const deadline = setTimeout(() => {
      if (exitInfo) concludeExit();
      else finish({ ok: true });
    }, LAUNCH_GRACE_MS);

    child.once("error", (err) => {
      finish(failure(err instanceof Error ? err.message : String(err)));
    });

    child.once("exit", (code, signal) => {
      if (code === 0) {
        finish({ ok: true });
        return;
      }
      exitInfo = { code, signal };
      // Give the stderr pipe a beat to flush before reporting; "close" (all
      // stdio ended) concludes immediately when it arrives first. close alone
      // is not enough: a grandchild inheriting the pipe can hold it open.
      setTimeout(concludeExit, 50);
    });

    child.once("close", (code, signal) => {
      if (code === 0) {
        finish({ ok: true });
        return;
      }
      exitInfo = { code, signal };
      concludeExit();
    });

    // The launcher runs on its own; never keep this process alive for it.
    child.unref();
  });
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
 * Reveal a file in the OS file manager.
 */
export function revealFile(absPath: string): Promise<OpenInLaunchResult> {
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
export function openWithApp(
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
 * Hand a file to the OS default handler: `open <file>` on macOS,
 * `explorer <file>` on Windows (no cmd parser between the path and the
 * launch), `xdg-open <file>` on Linux.
 *
 * DANGEROUS by design: the default handler of `.command`, `.app`, `.sh`,
 * `.exe` and friends runs them. Nothing reaches this implicitly (#1915 took
 * the fallback out of openFileInApp). Its one caller is the Inbox's launch
 * route, which allows it only for the kinds its per-kind policy names
 * (`inboxOpenInPolicy`: images and PDFs whose bytes and extension agree, and
 * a few text formats on macOS and Windows).
 */
export function openWithSystemDefault(absPath: string): Promise<OpenInLaunchResult> {
  const platform = currentPlatform();
  if (platform === "mac") return runArgv("open", [absPath], "the default app");
  // explorer.exe exits non-zero even on success; launch fire-and-forget.
  if (platform === "win") return spawnDetached("explorer", [absPath], "the default app");
  return runArgv("xdg-open", [absPath], "the default app");
}

/**
 * Open a file in the given app (by catalog id). A missing or unknown id is a
 * failure, never a launch: there is deliberately no fallback to the OS
 * default handler, which could execute the file (see checkOpenInAppId).
 */
export async function openFileInApp(
  absPath: string,
  appId: string,
): Promise<OpenInLaunchResult> {
  const checked = checkOpenInAppId(appId);
  if (!checked.ok) return { ok: false, error: checked.error };
  const app = checked.app;

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
 * Whether open-in is off for this session: remote mode, or a session
 * published over the tailnet (`--tailscale`), which other devices reach. A
 * launch opens an app on THIS machine for whoever sent it, so it is offered
 * only to a session only this computer reaches (the update route's
 * `update_exposed` rule).
 */
function openInExposed(exposed: boolean | undefined): boolean {
  return isRemoteSession() || exposed === true;
}

/**
 * GET /api/open-in/apps handler.
 *
 * `available` is false in remote/headless sessions and in sessions published
 * over the tailnet (`exposed`; the UI hides the control entirely). `apps` is
 * the host-filtered catalog (always includes 'reveal'); empty when unavailable.
 */
export function handleOpenInApps(options: { exposed?: boolean } = {}): Response {
  if (openInExposed(options.exposed)) {
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
  /**
   * This server's stale-tab nonce (packages/core/server-session.ts). A body
   * carrying a different `serverSession` is refused with 409 before anything
   * launches; a body without one is accepted.
   */
  serverSession?: string;
  /**
   * The session is published over the tailnet (`--tailscale`): other devices
   * reach it, so nothing is launched (400), as in remote mode.
   */
  exposed?: boolean;
}

/**
 * POST /api/open-in handler. Refuses another site's page (including the
 * sandboxed annotated-HTML frame, which sends `Origin: null`) and a stale tab,
 * requires a catalog `appId`, resolves + containment-checks the target via
 * resolveOpenInTarget (shared), then launches via openFileInApp.
 */
export async function handleOpenIn(
  req: Request,
  options: HandleOpenInOptions = {},
): Promise<Response> {
  if (openInExposed(options.exposed)) {
    return Response.json(
      { ok: false, error: "Open in app is unavailable in sessions other devices can reach" },
      { status: 400 },
    );
  }

  // Launching an app is a state change on the user's machine: a page on
  // another site must never reach it with a preflight-free text/plain POST.
  if (
    !isSameOriginOrNoOrigin(
      req.headers.get("origin"),
      new URL(req.url).host,
      req.headers.get("sec-fetch-site"),
    )
  ) {
    return Response.json(
      { ok: false, error: "Cross-origin requests are not allowed" },
      { status: 403 },
    );
  }

  let body: { filePath?: unknown; base?: unknown; appId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "Invalid request" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ ok: false, error: "Invalid request" }, { status: 400 });
  }

  // Stale-tab guard: a tab left open on a reused port must not launch apps
  // for a session it never showed. Missing is accepted.
  if (
    options.serverSession !== undefined &&
    checkServerSession(body, options.serverSession) === "mismatch"
  ) {
    return Response.json(serverSessionMismatchBody(), { status: 409 });
  }

  const filePath = typeof body.filePath === "string" ? body.filePath : "";
  if (!filePath) {
    return Response.json({ ok: false, error: "Missing filePath" }, { status: 400 });
  }
  const base = typeof body.base === "string" ? body.base : null;
  const app = checkOpenInAppId(body.appId);
  if (!app.ok) {
    return Response.json({ ok: false, error: app.error }, { status: 400 });
  }

  const abs = resolveOpenInTarget(filePath, base, options.resolveRoot);
  if (abs == null) {
    return Response.json({ ok: false, error: "Access denied" }, { status: 403 });
  }

  const result = await openFileInApp(abs, app.app.id);
  // A failed launch is a valid request with the result in the body (ok:false),
  // not a server error — return 200 and let the client read `ok`. Matches Pi.
  return Response.json(result);
}
