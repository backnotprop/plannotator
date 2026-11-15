import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cfAccessDir } from "@plannotator/shared/inbox/cf-access-door";
import { cleanLogLine, freeLoopbackPort, metricsArgs, readyConnections, REGISTERED_LINE } from "./cf-ready";

export type CfTunnelPhase = "starting" | "connected" | "retrying" | "missing" | "stopped";

export interface CfTunnelState {
  state: CfTunnelPhase;
  pid: number | null;
  connections: number;
  restarts: number;
  error: string | null;
}

export interface CfTunnelTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

export interface CfTunnelOptions {
  dataDir: string;
  binary: string | null;
  log: (line: string) => void;
  onChange: () => void;
  timers: CfTunnelTimers;
  now: () => number;
}

export const CF_TUNNEL_BACKOFF = { firstMs: 1_000, maxMs: 60_000, healthyMs: 60_000 };
const HOMEBREW_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

export function tunnelTokenPath(dataDir: string): string {
  return join(cfAccessDir(dataDir), "tunnel-token");
}

export function findCloudflared(env: NodeJS.ProcessEnv = process.env): string | null {
  const name = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const extra = process.platform === "darwin" ? HOMEBREW_DIRS : [];
  const sep = process.platform === "win32" ? ";" : ":";
  const path = [env.PATH ?? "", ...extra].filter(Boolean).join(sep);
  return Bun.which(name, { PATH: path }) ?? null;
}

export function cloudflaredInstallHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "Install it with Homebrew: brew install cloudflared";
  if (platform === "win32") return "Install it with: winget install --id Cloudflare.cloudflared";
  return "Install it from Cloudflare's packages: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";
}

const defaultTimers: CfTunnelTimers = {
  set: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const UNREGISTERED = /(?:Unregistered tunnel connection|Connection terminated|Lost connection)\b.*?\bconnIndex=(\d+)/;
const ERROR_LINE = /\b(?:ERR|error)\b/;


export function tunnelEnv(token: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keep = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "LANG", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"];
  const out: Record<string, string> = { TUNNEL_TOKEN: token, NO_AUTOUPDATE: "true" };
  for (const name of keep) if (env[name] !== undefined) out[name] = env[name]!;
  return out;
}

export function createCfTunnel(partial: Partial<CfTunnelOptions> & { dataDir: string; log: (line: string) => void; onChange: () => void }) {
  const options: CfTunnelOptions = {
    ...partial,
    binary: partial.binary === undefined ? findCloudflared() : partial.binary,
    timers: partial.timers ?? defaultTimers,
    now: partial.now ?? Date.now,
  };
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let retry: unknown = null;
  let backoff = CF_TUNNEL_BACKOFF.firstMs;
  let startedAt = 0;
  let wanted = false;
  const connected = new Set<string>();
  const state: CfTunnelState = { state: "stopped", pid: null, connections: 0, restarts: 0, error: null };

  const set = (patch: Partial<CfTunnelState>) => {
    Object.assign(state, patch);
    options.onChange();
  };

  const readLines = async (stream: ReadableStream<Uint8Array> | null, own: ReturnType<typeof Bun.spawn>) => {
    if (!stream) return;
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of stream) {
      buffered += decoder.decode(chunk, { stream: true });
      let at: number;
      while ((at = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        if (child !== own) continue;
        const up = REGISTERED_LINE.exec(line);
        const down = UNREGISTERED.exec(line);
        if (up) connected.add(up[1]!);
        else if (down) connected.delete(down[1]!);
        else if (ERROR_LINE.test(line)) state.error = cleanLogLine(line);
        if (up || down) set({ connections: connected.size, state: connected.size > 0 ? "connected" : "starting", ...(up ? { error: null } : {}) });
      }
    }
  };

  const spawnChild = () => {
    retry = null;
    if (!wanted) return;
    if (!options.binary) {
      set({ state: "missing", pid: null, connections: 0, error: "cloudflared is not installed." });
      return;
    }
    const tokenFile = tunnelTokenPath(options.dataDir);
    const token = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "";
    if (!token) {
      set({ state: "missing", pid: null, connections: 0, error: "The tunnel token is missing; run plannotator inbox cloudflare-access setup again." });
      return;
    }
    connected.clear();
    startedAt = options.now();
    const metricsPort = freeLoopbackPort();
    const own = Bun.spawn([options.binary, "tunnel", "--no-autoupdate", ...metricsArgs(metricsPort), "run"], {
      env: tunnelEnv(token),
      windowsHide: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    child = own;
    set({ state: "starting", pid: own.pid, connections: 0 });
    const poll = setInterval(() => {
      void readyConnections(metricsPort).then((ready) => {
        if (child !== own || ready === null || ready === state.connections) return;
        set({ connections: ready, state: ready > 0 ? "connected" : "starting", ...(ready > 0 ? { error: null } : {}) });
      });
    }, 5_000);
    poll.unref?.();
    void own.exited.then(() => clearInterval(poll));
    void readLines(own.stdout as ReadableStream<Uint8Array>, own);
    void readLines(own.stderr as ReadableStream<Uint8Array>, own);
    void own.exited.then((code) => {
      if (child !== own) return;
      child = null;
      connected.clear();
      if (!wanted) return;
      if (options.now() - startedAt >= CF_TUNNEL_BACKOFF.healthyMs) backoff = CF_TUNNEL_BACKOFF.firstMs;
      set({ state: "retrying", pid: null, connections: 0, restarts: state.restarts + 1, error: state.error ?? `cloudflared exited (${code}).` });
      options.log(`[plannotator] cloudflared exited (${code}); starting it again in ${Math.round(backoff / 1000)} s.\n`);
      retry = options.timers.set(spawnChild, backoff);
      backoff = Math.min(backoff * 2, CF_TUNNEL_BACKOFF.maxMs);
    });
  };

  const start = () => {
    if (wanted) return;
    wanted = true;
    backoff = CF_TUNNEL_BACKOFF.firstMs;
    state.restarts = 0;
    state.error = null;
    spawnChild();
  };

  const stop = () => {
    wanted = false;
    if (retry !== null) options.timers.clear(retry);
    retry = null;
    const closing = child;
    child = null;
    connected.clear();
    if (closing) {
      closing.kill("SIGTERM");
      const force = setTimeout(() => closing.kill("SIGKILL"), 5_000);
      force.unref?.();
      void closing.exited.then(() => clearTimeout(force));
    }
    Object.assign(state, { state: "stopped", pid: null, connections: 0 });
  };

  return { start, stop, state: (): CfTunnelState => ({ ...state }) };
}
