import { parsePortSelection, type ParsedPortSelection } from "./port-range";

/** Live proxies never inherit the editor's remote-mode port or bind address. */
export function getLiveProxyPortSelection(): ParsedPortSelection {
  const value = process.env.PLANNOTATOR_LIVE_PORT;
  if (value) {
    const parsed = parsePortSelection(value);
    if (parsed) return parsed;
    console.error(`[Plannotator] Warning: Invalid PLANNOTATOR_LIVE_PORT "${value}", using default`);
  }
  return { kind: "fixed", ports: [0] };
}

/** The error code a failed listen carries (`EADDRINUSE`, `EACCES`, ...), if any. */
export function listenErrorCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code) return code;
  if (error.message.includes("EADDRINUSE")) return "EADDRINUSE";
  return null;
}

/**
 * Codes a range moves past, trying the next port: the port is taken
 * (EADDRINUSE) or this user may not bind it (EACCES, a port below 1024 when
 * not root). Any other code ends the attempt with a clear error.
 */
const SKIPPABLE_CODES = new Set(["EADDRINUSE", "EACCES"]);

const CODE_HINTS: Record<string, string> = {
  EACCES: "permission denied",
  EADDRINUSE: "already in use",
  EADDRNOTAVAIL: "address not available",
};

function codeText(code: string): string {
  const hint = CODE_HINTS[code];
  return hint ? `${code}: ${hint}` : code;
}

/**
 * A live app proxy that could not bind any port PLANNOTATOR_LIVE_PORT allows.
 * The message is one line, written for the person who set the variable. The
 * CLI prints it as a startup failure without a stack trace.
 */
export class LiveProxyPortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveProxyPortError";
  }
}

/** Every port the selection allows is taken. */
export class LiveProxyPortInUseError extends LiveProxyPortError {
  constructor(selection: ParsedPortSelection) {
    const detail = selection.kind === "range"
      ? `every port in PLANNOTATOR_LIVE_PORT ${selection.ports[0]}-${selection.ports.at(-1)} is already in use`
      : `port ${selection.ports[0]} (PLANNOTATOR_LIVE_PORT) is already in use`;
    super(`Plannotator: live app proxy ${detail}. Close another live annotation session or set PLANNOTATOR_LIVE_PORT to a different port or range.`);
    this.name = "LiveProxyPortInUseError";
  }
}

const NEXT_STEP = "Set PLANNOTATOR_LIVE_PORT to a different port or range.";

function nextStep(failures: ReadonlyArray<{ port: number; code: string }>): string {
  const lowPortDenied = failures.some((f) => f.code === "EACCES" && f.port > 0 && f.port < 1024);
  return lowPortDenied ? `Ports below 1024 usually need root. ${NEXT_STEP}` : NEXT_STEP;
}

function onePortFailure(port: number, code: string, next: string): string {
  const subject = port === 0
    ? "could not bind a loopback port"
    : `port ${port} (PLANNOTATOR_LIVE_PORT) could not be used`;
  return `Plannotator: live app proxy ${subject} (${codeText(code)}). ${next}`;
}

/**
 * The port loop both transports share. Call `failed(port, error)` for each
 * port that would not bind: it returns when the loop should try the next
 * port, and throws when it should stop (an unexpected code ends it with one
 * clear line; an error without a code is rethrown as it is, since that is a
 * bug, not a port problem). When the loop runs out, throw `exhausted()`.
 */
export function createLiveProxyPortAttempts(selection: ParsedPortSelection) {
  const failures: Array<{ port: number; code: string }> = [];
  return {
    failed(port: number, error: unknown): void {
      const code = listenErrorCode(error);
      if (code === null) throw error;
      if (SKIPPABLE_CODES.has(code)) {
        failures.push({ port, code });
        return;
      }
      throw new LiveProxyPortError(onePortFailure(port, code, nextStep([{ port, code }])));
    },
    exhausted(): LiveProxyPortError {
      if (failures.every((failure) => failure.code === "EADDRINUSE")) {
        return new LiveProxyPortInUseError(selection);
      }
      if (selection.kind === "fixed") {
        const { port, code } = failures[0]!;
        return new LiveProxyPortError(onePortFailure(port, code, nextStep(failures)));
      }
      const counts = new Map<string, number>();
      for (const { code } of failures) counts.set(code, (counts.get(code) ?? 0) + 1);
      const detail = [...counts]
        .map(([code, count]) => code === "EADDRINUSE" ? `${count} in use` : `${count} ${CODE_HINTS[code] ?? "failed"} (${code})`)
        .join(", ");
      return new LiveProxyPortError(
        `Plannotator: live app proxy could not use any port in PLANNOTATOR_LIVE_PORT ${selection.ports[0]}-${selection.ports.at(-1)} (${detail}). ${nextStep(failures)}`,
      );
    },
  };
}
