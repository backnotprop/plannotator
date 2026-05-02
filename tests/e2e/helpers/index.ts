export * from "./daemon";
export * from "./cli";
export * from "./fs-sandbox";
export * from "./browser";

import { getDaemonStatus } from "./daemon";

async function fetchStatus(port: number): Promise<{ status: string }> {
  const status = await getDaemonStatus(port);
  if (!status) {
    throw new Error(
      `Expected the daemon at port ${port} to respond to /api/state, but it did not.`,
    );
  }
  return status;
}

export async function expectIdle(port: number): Promise<void> {
  const status = await fetchStatus(port);
  if (status.status !== "idle") {
    throw new Error(
      `Expected daemon at port ${port} to be idle, but status was ${status.status}.`,
    );
  }
}

export async function expectActive(
  port: number,
  opts: { mode?: string } = {},
): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/api/state`);
  if (!response.ok) {
    throw new Error(
      `Expected /api/state to be reachable on port ${port}, got HTTP ${response.status}.`,
    );
  }
  const body = (await response.json()) as {
    status?: string;
    document?: { mode?: string } | null;
  };
  if (body.status !== "awaiting-response") {
    throw new Error(
      `Expected daemon at port ${port} to be awaiting-response, but status was ${body.status}.`,
    );
  }
  if (opts.mode) {
    const mode = body.document?.mode;
    if (mode !== opts.mode) {
      throw new Error(
        `Expected active document mode ${opts.mode} on port ${port}, got ${mode ?? "<missing>"}.`,
      );
    }
  }
}

export async function expectVerdictReady(port: number): Promise<void> {
  const status = await fetchStatus(port);
  if (status.status !== "resolved") {
    throw new Error(
      `Expected daemon at port ${port} to have a verdict (status=resolved), but status was ${status.status}.`,
    );
  }
}
