export function freeLoopbackPort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = probe.port as number;
  probe.stop(true);
  return port;
}

export function metricsArgs(port: number): string[] {
  return ["--metrics", `127.0.0.1:${port}`];
}

export async function readyConnections(port: number): Promise<number | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(2_000) });
    const body = (await response.json().catch(() => null)) as { readyConnections?: unknown } | null;
    return typeof body?.readyConnections === "number" ? body.readyConnections : null;
  } catch {
    return null;
  }
}

export function cleanLogLine(line: string): string {
  return line.replace(/[A-Za-z0-9_+/=-]{40,}/g, "[redacted]").trim().slice(0, 300);
}

export const REGISTERED_LINE = /Registered tunnel connection\b.*?\bconnIndex=(\d+)/;
