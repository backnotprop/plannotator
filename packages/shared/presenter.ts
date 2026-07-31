/**
 * External presentation protocol shared by the Bun server and Pi's Node
 * runtime. The configured executable receives exactly one JSON record on stdin
 * and must return exactly one JSON record on stdout.
 */

import { spawn } from "node:child_process";
import { loadConfig, type PlannotatorConfig } from "./config";

export const PRESENTER_PROTOCOL_VERSION = 1;
/** Maximum time allowed for an external presenter to accept a URL. */
export const PRESENTER_PRESENT_TIMEOUT_MS = 15_000;
/** Maximum time allowed for an external presenter to dismiss its presentation. */
export const PRESENTER_DISMISS_TIMEOUT_MS = 5_000;
export const PRESENTER_MAX_OUTPUT_BYTES = 64 * 1024;
/**
 * SIGTERM→SIGKILL escalation delay for a presenter that outlives its
 * operation. Short enough to fit inside the hook CLI's shutdown budget
 * (dismiss timeout + headroom) so the escalation is actually reachable
 * before the coordinator force-exits; the synchronous exit-time kill below
 * covers the window where the process exits before this timer fires.
 */
const PRESENTER_TERMINATION_GRACE_MS = 2_000;

/**
 * Presenter children that have not yet exited. On process exit, any child
 * still alive is SIGKILLed synchronously: the escalation timers above are
 * unref'd so they never hold the event loop open, which also means a
 * force-exit can beat them — without this handler a hung presenter child
 * would be orphaned.
 */
const livePresenterChildren = new Set<ReturnType<typeof spawn>>();
let presenterExitKillInstalled = false;

function trackPresenterChild(child: ReturnType<typeof spawn>): void {
  if (!presenterExitKillInstalled) {
    presenterExitKillInstalled = true;
    process.on("exit", () => {
      for (const live of livePresenterChildren) {
        try {
          live.kill("SIGKILL");
        } catch {
          // The child may have exited between the check and the kill.
        }
      }
    });
  }
  livePresenterChildren.add(child);
  child.once("exit", () => {
    livePresenterChildren.delete(child);
  });
}

export type PresentationKind =
  | "plan"
  | "review"
  | "annotate"
  | "archive"
  | "goal-setup";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type PresenterRequest =
  | {
      protocol: typeof PRESENTER_PROTOCOL_VERSION;
      action: "present";
      url: string;
      kind: PresentationKind;
    }
  | {
      protocol: typeof PRESENTER_PROTOCOL_VERSION;
      action: "dismiss";
      handle: JsonValue;
    };

export interface PresenterOperationResult {
  ok: boolean;
  error?: string;
}

export interface ExternalPresentation {
  handle: JsonValue;
  dismiss: () => Promise<PresenterOperationResult>;
}

export type PresentUrlResult =
  | { attempted: false; opened: false }
  | { attempted: true; opened: false; error: string }
  | {
      attempted: true;
      opened: true;
      presentation: ExternalPresentation;
    };

export type PresenterCommandResult =
  | { ok: true; response: Record<string, unknown> }
  | { ok: false; error: string };

interface PresenterOptions {
  config?: PlannotatorConfig;
  env?: NodeJS.ProcessEnv;
  invoke?: typeof invokePresenterCommand;
  signal?: AbortSignal;
  onDismissError?: (error: string) => void;
}

interface PresenterCommandOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseError(response: Record<string, unknown>): string {
  const error = response.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (isRecord(error)) {
    const message = typeof error.message === "string" ? error.message.trim() : "";
    const code = typeof error.code === "string" ? error.code.trim() : "";
    if (code && message) return `${code}: ${message}`;
    if (message) return message;
    if (code) return code;
  }
  return "presenter reported a failure";
}

function commandExitError(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): string {
  const detail = stderr.trim();
  const status = signal
    ? `terminated by ${signal}`
    : `exited with status ${code ?? "unknown"}`;
  return detail ? `presenter ${status}: ${detail}` : `presenter ${status}`;
}

/**
 * Resolve the configured executable without shell parsing.
 *
 * An explicitly-set PLANNOTATOR_PRESENTER wins and may run anywhere. An empty
 * explicit value disables the config-file presenter. Config-file presenters
 * default to Herdr-only so installing the integration does not change normal
 * terminal/browser behavior.
 */
export function resolvePresenterCommand(
  config: PlannotatorConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (Object.prototype.hasOwnProperty.call(env, "PLANNOTATOR_PRESENTER")) {
    const explicit = env.PLANNOTATOR_PRESENTER?.trim();
    return explicit || undefined;
  }

  const presenter = config.presenter;
  if (!presenter || typeof presenter !== "object") return undefined;
  const command = typeof presenter.command === "string"
    ? presenter.command.trim()
    : "";
  if (!command) return undefined;

  const when = presenter.when === "always" ? "always" : "herdr";
  if (when === "herdr" && env.HERDR_ENV !== "1") return undefined;
  return command;
}

/**
 * Invoke one presenter operation. Failures are returned as values so callers
 * can preserve the native-browser fallback.
 */
export async function invokePresenterCommand(
  command: string,
  request: PresenterRequest,
  options: PresenterCommandOptions = {},
): Promise<PresenterCommandResult> {
  const timeoutMs = options.timeoutMs ?? (
    request.action === "present"
      ? PRESENTER_PRESENT_TIMEOUT_MS
      : PRESENTER_DISMISS_TIMEOUT_MS
  );
  const maxOutputBytes =
    options.maxOutputBytes ?? PRESENTER_MAX_OUTPUT_BYTES;

  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ ok: false, error: "presenter cancelled" });
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [], {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: options.env,
      });
    } catch (error) {
      resolve({
        ok: false,
        error: `failed to start presenter: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      return;
    }
    trackPresenterChild(child);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: PresenterCommandResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", cancel);
      resolve(result);
    };

    const terminate = (error: string) => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Best effort; the operation has already failed from the caller's view.
      }
      const escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            // The process may have exited between the state check and kill.
          }
        }
      }, PRESENTER_TERMINATION_GRACE_MS);
      escalation.unref();
      finish({ ok: false, error });
    };

    const cancel = () => terminate("presenter cancelled");

    const collect = (target: Buffer[], chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.byteLength;
      if (outputBytes > maxOutputBytes) {
        terminate(`presenter output exceeded ${maxOutputBytes} bytes`);
        return;
      }
      target.push(bytes);
    };

    child.stdout!.on("data", (chunk) => collect(stdoutChunks, chunk));
    child.stderr!.on("data", (chunk) => collect(stderrChunks, chunk));
    child.once("error", (error) => {
      finish({ ok: false, error: `failed to start presenter: ${error.message}` });
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();

      let response: unknown;
      try {
        response = JSON.parse(stdout);
      } catch {
        if (code !== 0 || signal) {
          finish({ ok: false, error: commandExitError(code, signal, stderr) });
        } else {
          finish({
            ok: false,
            error: stdout
              ? "presenter returned invalid JSON"
              : "presenter returned no response",
          });
        }
        return;
      }

      if (!isRecord(response)) {
        finish({ ok: false, error: "presenter response must be a JSON object" });
        return;
      }
      if (response.protocol !== PRESENTER_PROTOCOL_VERSION) {
        finish({
          ok: false,
          error: `unsupported presenter protocol: ${String(response.protocol)}`,
        });
        return;
      }
      if (response.ok !== true) {
        finish({ ok: false, error: responseError(response) });
        return;
      }
      if (code !== 0 || signal) {
        finish({ ok: false, error: commandExitError(code, signal, stderr) });
        return;
      }
      finish({ ok: true, response });
    });

    timeout = setTimeout(() => {
      terminate(`presenter timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    timeout.unref();
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) {
      cancel();
    }

    child.stdin!.on("error", () => {
      // The close/error event carries the authoritative process result.
    });
    child.stdin!.end(`${JSON.stringify(request)}\n`);
  });
}

/**
 * Present a URL with the configured external presenter.
 */
export async function presentUrl(
  url: string,
  kind: PresentationKind,
  options: PresenterOptions = {},
): Promise<PresentUrlResult> {
  // Keep the presenter lifecycle on one stable environment snapshot. This
  // matters for long-lived runtimes and also guarantees that dismiss uses the
  // same Herdr session/context that created the handle.
  const env = { ...(options.env ?? process.env) };
  const config = options.config ?? loadConfig();
  const command = resolvePresenterCommand(config, env);
  if (!command) return { attempted: false, opened: false };

  const invoke = options.invoke ?? invokePresenterCommand;
  const result = await invoke(command, {
    protocol: PRESENTER_PROTOCOL_VERSION,
    action: "present",
    url,
    kind,
  }, {
    signal: options.signal,
    env,
    timeoutMs: PRESENTER_PRESENT_TIMEOUT_MS,
  });
  if (!result.ok) {
    return { attempted: true, opened: false, error: result.error };
  }
  if (!Object.prototype.hasOwnProperty.call(result.response, "handle")) {
    return {
      attempted: true,
      opened: false,
      error: "presenter success response is missing handle",
    };
  }

  const handle = result.response.handle as JsonValue;
  const reportDismissError = options.onDismissError ?? ((error: string) => {
    process.stderr.write(
      `[plannotator] External presenter cleanup failed: ${error}\n`,
    );
  });
  let dismissPromise: Promise<PresenterOperationResult> | undefined;
  const presentation: ExternalPresentation = {
    handle,
    dismiss: () => {
      dismissPromise ??= (async () => {
        const dismissed = await invoke(command, {
          protocol: PRESENTER_PROTOCOL_VERSION,
          action: "dismiss",
          handle,
        }, {
          env,
          timeoutMs: PRESENTER_DISMISS_TIMEOUT_MS,
        });
        const result = dismissed.ok
          ? { ok: true }
          : { ok: false, error: dismissed.error };
        if (!result.ok) {
          reportDismissError(result.error ?? "presenter cleanup failed");
        }
        return result;
      })();
      return dismissPromise;
    },
  };

  return { attempted: true, opened: true, presentation };
}

const activePresentations = new Map<string, ExternalPresentation>();

/** Associate a successfully opened presentation with its server URL. */
export function trackPresentation(
  url: string,
  presentation: ExternalPresentation,
): void {
  const previous = activePresentations.get(url);
  activePresentations.set(url, presentation);
  if (previous && previous !== presentation) {
    void previous.dismiss();
  }
}

/**
 * Remove and return the presentation currently owned by a server URL.
 *
 * Servers take ownership synchronously before releasing their listening port,
 * so a later server that reuses the same URL cannot be dismissed by the older
 * server's asynchronous shutdown.
 */
export function takePresentation(
  url: string,
): ExternalPresentation | undefined {
  const presentation = activePresentations.get(url);
  if (!presentation) return undefined;
  activePresentations.delete(url);
  return presentation;
}

/** Dismiss the presentation owned by a server URL, if one exists. */
export async function dismissPresentation(
  url: string,
): Promise<PresenterOperationResult> {
  const presentation = takePresentation(url);
  if (!presentation) return { ok: true };
  return presentation.dismiss();
}
