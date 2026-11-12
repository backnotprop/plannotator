import { parsePortSelection, type ParsedPortSelection } from "./port-range";

export function getLiveProxyPortSelection(): ParsedPortSelection {
  const value = process.env.PLANNOTATOR_LIVE_PORT;
  if (value) {
    const parsed = parsePortSelection(value);
    if (parsed) return parsed;
    console.error(`[Plannotator] Warning: Invalid PLANNOTATOR_LIVE_PORT "${value}", using default`);
  }
  return { kind: "fixed", ports: [0] };
}

export function listenErrorCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code) return code;
  if (error.message.includes("EADDRINUSE")) return "EADDRINUSE";
  return null;
}

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

export class LiveProxyPortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveProxyPortError";
  }
}

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
