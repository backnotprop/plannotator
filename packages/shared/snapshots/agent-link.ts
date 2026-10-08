/**
 * Plannotator Snapshots: the agent-session link for hosts whose plugins run
 * in a JavaScript runtime with `node:` modules, the Pi extension (vendored into
 * `apps/pi-extension/generated/snapshots/` by `vendor.sh`) and the OpenCode 2
 * plugin. The Claude Code mod has its own copy of this logic over the
 * engine's `$` (`apps/hook/hooks/mod/snapshots.ts`); the protocol is the
 * hub's (`packages/server/snapshots/connections.ts`), never re-written.
 *
 *  - `summonSnapshots`: `/plannotator-snapshot`. Runs
 *    `plannotator snapshot --session <host>:<id> [--app]` (a one-shot that
 *    starts the hub and the app, latches this session as the destination and
 *    opens the capture overlay) and returns its line. macOS only: elsewhere
 *    it explains, and points at `plannotator snapshot add` / `open`.
 *  - `SnapshotsAgentLink`: one per agent session. Looks for the hub's
 *    registry (`snapshots/hub.json`) every few seconds (a file read, no
 *    process), says hello, and long-polls the session's own pull bridge on the
 *    hub with the host half of the pull-bridge protocol
 *    (`runPullSessionBridgeClient`, injected so this file imports nothing but
 *    `node:` modules). Over that link:
 *      - `deliver`: a send from the HUD. Claimed once across processes (mkdir
 *        of `snapshots/claims/<host>-<send id>`), acknowledged
 *        `deliver_accepted { queued }`, handed to the host (Pi: a `followUp`
 *        user message; OpenCode: `session.prompt` with `delivery: "queue"`),
 *        and acknowledged `delivered`. The hub re-sends until then, so a send
 *        is never lost to a restart and never delivered twice.
 *      - `ask` / `cancel` / `interrupt`: "Ask this session" from the HUD, run
 *        by the host's own session bridge as a real turn.
 *    Every poll carries when a person last typed into the session, which is
 *    how a hotkey-started collection picks it.
 *    Nothing is spawned, watched or probed until a hub is found: the project
 *    name (`git rev-parse`) and the host's Ask bridge are made when the link
 *    connects, and the bridge is handed back when the connection ends.
 *    Two host processes on one session (`pi -c` twice, two OpenCode servers)
 *    share ONE hub connection, so only the holder of the session's lease
 *    (`snapshots/leases/<host>-<session>.json`, the Inbox wake's rule: the
 *    process the person used last, renewed every 5 s, free after 20 s,
 *    released on exit) says hello, polls and delivers; the other waits.
 */

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** The hosts this link serves (the mod and `snapshot --wait` have their own). */
export type SnapshotsLinkHost = "pi" | "opencode";

/** No hub yet: look for its registry again after this long. */
export const SNAPSHOTS_NO_HUB_RETRY_MS = 5_000;
/** A claim nobody marked delivered for this long belongs to a process that died mid-delivery. */
const CLAIM_STALE_MS = 10 * 60_000;
/** Claims are kept this long (sent collections are kept 7 days). */
const CLAIM_KEEP_MS = 7 * 24 * 60 * 60_000;
const SUMMON_TIMEOUT_MS = 30_000;
const TITLE_MAX = 60;
/** How often a connected link renews (or re-reads) its session's lease (the Inbox wake's 5 s). */
export const SNAPSHOTS_LEASE_EVERY_MS = 5_000;
/** A lease not renewed for this long belongs to a process that exited, slept or hung (the Inbox wake's 20 s). */
export const SNAPSHOTS_LEASE_STALE_MS = 20_000;
/** What a plannotator from before Snapshots answers `plannotator snapshot` with. */
const OLDER_CLI = /unknown (sub)?command|no plan content in hook event/i;
export const SNAPSHOTS_UPDATE_TEXT = "The plannotator on this machine has no Snapshots (an older version); update Plannotator.";
/** What `plannotator snapshot` says when the Mac app is missing, after it summoned this session (so the session is linked). */
const APP_MISSING = /Plannotator Snapshots is not installed/;
/** The host's answer then: the session is linked, only the app is missing. Kept equal to the Claude Code mod's copy (apps/hook/hooks/mod/snapshots.ts). */
export const SNAPSHOTS_APP_MISSING_TEXT =
  "This session is linked to Plannotator Snapshots, but the Mac app is not installed: run `plannotator snapshot install-app`.";

export const SNAPSHOTS_MACOS_ONLY_TEXT =
  "Plannotator Snapshots captures the screen on macOS only for now. Here you can add an image with `plannotator snapshot add <file>` and open the HUD in a browser with `plannotator snapshot open`; a send from it still arrives in this session.";

export const SNAPSHOTS_INSTALL_TEXT =
  "Plannotator Snapshots needs the plannotator command, and there is none on this machine: install Plannotator (https://plannotator.ai/docs/getting-started/installation/), then run /plannotator-snapshot again.";

/** The host half of the pull-bridge protocol, as this link drives it (`runPullSessionBridgeClient`). */
export interface SnapshotsPullClientOptions<B> {
  baseUrl: string;
  token: string;
  bridge: B;
  signal: AbortSignal;
  pollPath: string;
  eventPath: string;
  pollExtras: () => Record<string, unknown>;
  onExtraCommand: (command: { type: string } & Record<string, unknown>, post: (event: { type: string } & Record<string, unknown>) => void) => void;
  supersededWaitMs: () => number;
  log?: (message: string) => void;
}

export type SnapshotsPullClient<B> = (options: SnapshotsPullClientOptions<B>) => Promise<void>;

/** What a host gives one session's link. */
export interface SnapshotsLinkTarget {
  /** Hand a send's message to the session; resolves once the session took it. Rejects when it could not. */
  deliver(text: string, sendId: string): Promise<void>;
  /** A turn is running: the send waits behind it (the HUD says "Queued"). */
  isBusy(): boolean;
}

export interface SnapshotsAgentLinkOptions<B> {
  dataDir: string;
  host: SnapshotsLinkHost;
  sessionId: string;
  /** One per host process: two processes can share one session. */
  processId: string;
  cwd: string;
  /** The session's first words, shown in the HUD's picker. */
  title?: string;
  /**
   * The host's "Ask this session" bridge for this session, made only while
   * connected to a hub (a bridge may watch the session) and handed back to
   * `releaseBridge` when the connection ends.
   */
  createBridge: () => B;
  releaseBridge?: (bridge: B) => void;
  ask: { turn: boolean; transient: boolean };
  target: SnapshotsLinkTarget;
  runClient: SnapshotsPullClient<B>;
  log?: (line: string) => void;
  /** Test seams: how long to wait for a hub that is not there, and the lease renewal. */
  retryMs?: number;
  leaseEveryMs?: number;
}

interface HubEntry {
  url: string;
  token: string;
  port: number;
  serverSession: string;
  pid: number;
}

/** One session's lease on one host: which of its processes polls and delivers. */
export function snapshotsLeaseFileOf(dataDir: string, host: string, sessionId: string): string {
  return join(dataDir, "snapshots", "leases", `${host}-${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

export function snapshotsRegistryFileOf(dataDir: string): string {
  return join(dataDir, "snapshots", "hub.json");
}

function claimDirOf(dataDir: string, host: string, sendId: string): string {
  return join(dataDir, "snapshots", "claims", `${host}-${sendId.replace(/[^A-Za-z0-9._-]/g, "_")}`);
}

/** The hub's registry, loopback only: its token goes nowhere else. */
export function readSnapshotsHubEntry(dataDir: string): HubEntry | null {
  try {
    const value = JSON.parse(readFileSync(snapshotsRegistryFileOf(dataDir), "utf8")) as Record<string, unknown>;
    if (value.v !== 1 || typeof value.url !== "string" || typeof value.token !== "string") return null;
    const port = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(value.url);
    if (!port) return null;
    return {
      url: value.url,
      token: value.token,
      port: Number(port[1]),
      serverSession: typeof value.serverSession === "string" ? value.serverSession : "",
      pid: typeof value.pid === "number" ? value.pid : 0,
    };
  } catch {
    return null;
  }
}

export function snapshotsTitleOf(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The hub is up: its registry names a port that answers health with the registry's serverSession. */
export async function isSnapshotsHubRunning(dataDir: string): Promise<boolean> {
  const entry = readSnapshotsHubEntry(dataDir);
  return entry ? hubAnswers(entry) : false;
}

/**
 * The registry's hub process exists. `hub.json` stays on disk after the hub
 * exits, so this signal check comes before any fetch: a stale registry costs
 * a file read, never a loopback call to a dead port.
 */
function hubPidAlive(entry: HubEntry): boolean {
  if (!Number.isInteger(entry.pid) || entry.pid <= 0) return false;
  try {
    process.kill(entry.pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, under another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A live hub: its pid runs and its port answers health with the registry's serverSession. */
async function hubAnswers(entry: HubEntry): Promise<boolean> {
  if (!hubPidAlive(entry)) return false;
  try {
    const response = await fetch(`${entry.url}/api/snapshots/health`, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return false;
    return ((await response.json()) as { serverSession?: unknown }).serverSession === entry.serverSession;
  } catch {
    return false;
  }
}

/** The repository (or folder) name the HUD shows for a session. */
function projectOf(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5_000, windowsHide: true }, (error, stdout) => {
        const root = !error && typeof stdout === "string" && stdout.trim() ? stdout.trim() : cwd;
        resolve(basename(root));
      });
    } catch {
      resolve(basename(cwd));
    }
  });
}

/** The commands that may be `plannotator`: PLANNOTATOR_BIN, else `plannotator` on PATH, else ~/.local/bin/plannotator. */
export function plannotatorCommandCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.PLANNOTATOR_BIN?.trim();
  return configured ? [configured] : ["plannotator", join(homedir(), ".local", "bin", "plannotator")];
}

function runOnce(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ missing: boolean; exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (value: { missing: boolean; exitCode: number | null; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ missing: (error as NodeJS.ErrnoException).code === "ENOENT", exitCode: null, stdout: "", stderr: errorText(error) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      done({ missing: false, exitCode: null, stdout, stderr: `${stderr}\n(no answer within ${SUMMON_TIMEOUT_MS / 1000} s)` });
    }, SUMMON_TIMEOUT_MS);
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (error: NodeJS.ErrnoException) => done({ missing: error.code === "ENOENT", exitCode: null, stdout, stderr: error.message }));
    child.on("close", (code) => done({ missing: false, exitCode: code, stdout, stderr }));
  });
}

/**
 * `/plannotator-snapshot [--app]`: open the capture overlay with this session
 * as the destination. Returns at once with the line to show the person.
 */
export async function summonSnapshots(input: {
  dataDir: string;
  host: SnapshotsLinkHost;
  sessionId: string;
  args: string;
  cwd: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): Promise<{ ok: boolean; text: string }> {
  if ((input.platform ?? process.platform) !== "darwin") return { ok: false, text: SNAPSHOTS_MACOS_ONLY_TEXT };
  const env = input.env ?? process.env;
  const extra = input.args.split(/\s+/).filter((word) => word === "--app");
  const args = ["snapshot", "--session", `${input.host}:${input.sessionId}`, ...extra];
  for (const command of plannotatorCommandCandidates(env)) {
    const run = await runOnce(command, args, { cwd: input.cwd, env: { ...env, PLANNOTATOR_DATA_DIR: input.dataDir } });
    if (run.missing) continue;
    const output = (run.stderr || run.stdout).trim();
    if (run.exitCode !== 0) {
      if (OLDER_CLI.test(output)) return { ok: false, text: SNAPSHOTS_UPDATE_TEXT };
      if (APP_MISSING.test(output)) return { ok: false, text: SNAPSHOTS_APP_MISSING_TEXT };
      return { ok: false, text: `Plannotator Snapshots could not start: ${output || `exit ${run.exitCode}`}` };
    }
    return { ok: true, text: run.stdout.trim() || "Plannotator Snapshots is open." };
  }
  return { ok: false, text: SNAPSHOTS_INSTALL_TEXT };
}

/** One agent session's link to the Snapshots hub. */
export class SnapshotsAgentLink<B> {
  private disposed = false;
  private started = false;
  private readonly controller = new AbortController();
  /** Aborts the current connection (the lease moved to another process). */
  private runController: AbortController | null = null;
  private hub: HubEntry | null = null;
  private connectionId: string | null = null;
  private lastHumanInputAt = 0;
  private title: string;
  private project: string | null = null;
  private readonly delivering = new Set<string>();
  private wakeSleep: (() => void) | null = null;
  /** Names this link in the session's lease. */
  private readonly instanceId = randomUUID();
  private readonly leaseFile: string;
  private leader = false;
  /** When the person last acted in this process; the most recent touch wins the lease. */
  private touchedAt = 0;

  constructor(private readonly options: SnapshotsAgentLinkOptions<B>) {
    this.title = options.title ? snapshotsTitleOf(options.title) : "";
    this.leaseFile = snapshotsLeaseFileOf(options.dataDir, options.host, options.sessionId);
  }

  get sessionId(): string {
    return this.options.sessionId;
  }

  get connected(): boolean {
    return this.connectionId !== null;
  }

  /** Whether this process holds the session's lease (the one that polls and delivers). */
  get isLeader(): boolean {
    return this.leader;
  }

  /** Start looking for the hub. The person is in this process now. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.touchedAt = Date.now();
    this.pruneClaims();
    void this.loop().catch((error) => this.log(`link stopped: ${errorText(error)}`));
  }

  /** The hub went away: end the connection (and the host's bridge) now rather than after the poll gives up. */
  dropConnection(): void {
    this.runController?.abort();
  }

  /** Look for the hub now (`/plannotator-snapshot` may have just started it). */
  kick(): void {
    this.start();
    this.touch();
    this.wakeSleep?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    this.wakeSleep?.();
    // Let another process of this session take over at once.
    if (this.leader) writeLease(this.leaseFile, { owner: null, at: 0, touchedAt: 0 });
    this.leader = false;
    const { hub, connectionId } = this;
    if (hub && connectionId) {
      void fetch(`${hub.url}/api/connections/${connectionId}/bye`, { method: "POST", headers: this.headers(hub), body: "{}" }).catch(() => undefined);
    }
  }

  /** A person typed into this session: sends and Ask follow them to this process. */
  noteHumanInput(text?: string): void {
    this.lastHumanInputAt = Date.now();
    if (!this.title && text && text.trim() && !text.trimStart().startsWith("/")) this.title = snapshotsTitleOf(text);
    this.touch();
  }

  /** The person acted in this process: it takes the session's lease (the Inbox wake's rule). */
  touch(): void {
    this.touchedAt = Date.now();
    if (this.disposed || !this.started) return;
    const wasLeader = this.leader;
    this.holdLease(this.touchedAt);
    if (!wasLeader && this.leader) this.wakeSleep?.();
  }

  /**
   * Whether this process polls and delivers: it holds the session's lease
   * unless another live process does and the person touched that one at
   * least as recently. A lease not renewed for 20 s is free.
   */
  private holdLease(now: number): boolean {
    const lease = parseLease(readText(this.leaseFile));
    const foreign = !!lease?.owner && lease.owner !== this.instanceId && Math.abs(now - lease.at) < SNAPSHOTS_LEASE_STALE_MS;
    if (foreign && lease && lease.touchedAt >= this.touchedAt) {
      this.leader = false;
      return false;
    }
    writeLease(this.leaseFile, { owner: this.instanceId, at: now, touchedAt: this.touchedAt });
    this.leader = true;
    return true;
  }

  private log(line: string): void {
    this.options.log?.(`[Plannotator Snapshots] ${line}`);
  }

  private headers(hub: HubEntry): Record<string, string> {
    return { "content-type": "application/json", authorization: `Bearer ${hub.token}` };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      (timer as { unref?: () => void }).unref?.();
      const self = this;
      function done() {
        clearTimeout(timer);
        if (self.wakeSleep === done) self.wakeSleep = null;
        resolve();
      }
      this.wakeSleep = done;
    });
  }

  private async loop(): Promise<void> {
    const retryMs = this.options.retryMs ?? SNAPSHOTS_NO_HUB_RETRY_MS;
    const leaseEveryMs = this.options.leaseEveryMs ?? SNAPSHOTS_LEASE_EVERY_MS;
    while (!this.disposed) {
      // A file read: nothing is spawned, watched or probed until there is a hub.
      const hub = readSnapshotsHubEntry(this.options.dataDir);
      // A registry left by a hub that exited costs a file read and a pid check:
      // no fetch, no lease write, no git, until a live hub answers.
      if (!hub || !(await hubAnswers(hub))) {
        await this.sleep(retryMs);
        continue;
      }
      if (this.disposed) break;
      // Another process of this session holds it: that one polls and delivers.
      if (!this.holdLease(Date.now())) {
        await this.sleep(leaseEveryMs);
        continue;
      }
      this.project ??= await projectOf(this.options.cwd);
      if (this.disposed) break;
      let connectionId: string | null = null;
      try {
        const hello = await fetch(`${hub.url}/api/connections/hello`, {
          method: "POST",
          headers: this.headers(hub),
          body: JSON.stringify({
            host: this.options.host,
            sessionId: this.options.sessionId,
            processId: this.options.processId,
            cwd: this.options.cwd,
            project: this.project,
            title: this.title,
            lastHumanInputAt: this.lastHumanInputAt,
            capabilities: { deliver: true, ask: this.options.ask },
            protocol: 1,
          }),
          signal: this.controller.signal,
        });
        if (hello.ok) connectionId = ((await hello.json()) as { connectionId?: string }).connectionId ?? null;
        else await hello.body?.cancel().catch(() => undefined);
      } catch {
        connectionId = null;
      }
      if (this.disposed) break;
      if (!connectionId) {
        await this.sleep(retryMs);
        continue;
      }
      this.hub = hub;
      this.connectionId = connectionId;
      this.log(`connected to ${hub.url} as ${connectionId}`);
      const run = new AbortController();
      this.runController = run;
      const onDispose = () => run.abort();
      this.controller.signal.addEventListener("abort", onDispose, { once: true });
      // Renew the lease while connected; losing it ends this connection.
      const leaseTimer = setInterval(() => {
        if (!this.holdLease(Date.now())) {
          this.log("another process of this session took the link");
          run.abort();
        }
      }, leaseEveryMs);
      (leaseTimer as { unref?: () => void }).unref?.();
      // The session's Ask bridge exists only while connected.
      const bridge = this.options.createBridge();
      try {
        await this.options.runClient({
          baseUrl: hub.url,
          token: hub.token,
          bridge,
          signal: run.signal,
          pollPath: `/api/connections/${connectionId}/poll`,
          eventPath: `/api/connections/${connectionId}/event`,
          pollExtras: () => ({ lastHumanInputAt: this.lastHumanInputAt, ...(this.title ? { title: this.title } : {}) }),
          onExtraCommand: (command, post) => this.onCommand(command, post),
          supersededWaitMs: () => 10_000 + Math.floor(Math.random() * 5_000),
          log: (message) => this.options.log?.(message),
        });
      } catch (error) {
        this.log(`link failed: ${errorText(error)}`);
      } finally {
        clearInterval(leaseTimer);
        this.controller.signal.removeEventListener("abort", onDispose);
        this.runController = null;
        this.connectionId = null;
        this.options.releaseBridge?.(bridge);
      }
      if (this.disposed) break;
      // A hub that restarted (new token) or forgot us answers 401/404: say hello again soon.
      await this.sleep(1_000);
    }
  }

  private claim(sendId: string): "mine" | "delivered" | "theirs" {
    const dir = claimDirOf(this.options.dataDir, this.options.host, sendId);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        mkdirSync(join(dir, ".."), { recursive: true, mode: 0o700 });
        mkdirSync(dir);
        writeFileSync(join(dir, "owner"), this.options.processId, { mode: 0o600 });
        return "mine";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return "mine";
        try {
          statSync(join(dir, "delivered"));
          return "delivered";
        } catch {
          // Not delivered (yet).
        }
        try {
          if (Date.now() - statSync(dir).mtimeMs <= CLAIM_STALE_MS) return "theirs";
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // Gone in between: try again.
        }
      }
    }
    return "theirs";
  }

  private markDelivered(sendId: string): void {
    try {
      writeFileSync(join(claimDirOf(this.options.dataDir, this.options.host, sendId), "delivered"), new Date().toISOString(), { mode: 0o600 });
    } catch {
      // The hub has the ack; the marker only guards a second process.
    }
  }

  private releaseClaim(sendId: string): void {
    rmSync(claimDirOf(this.options.dataDir, this.options.host, sendId), { recursive: true, force: true });
  }

  private pruneClaims(): void {
    const dir = join(this.options.dataDir, "snapshots", "claims");
    try {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        try {
          if (Date.now() - statSync(path).mtimeMs > CLAIM_KEEP_MS) rmSync(path, { recursive: true, force: true });
        } catch {
          // Another process pruned it.
        }
      }
    } catch {
      // No claims yet.
    }
  }

  private onCommand(command: { type: string } & Record<string, unknown>, post: (event: { type: string } & Record<string, unknown>) => void): void {
    if (command.type !== "deliver" || typeof command.sendId !== "string" || typeof command.text !== "string") return;
    const { sendId, text } = command;
    if (this.delivering.has(sendId)) return;
    // The person may have moved to another process since the last renewal:
    // say nothing, and the hub re-sends to the process that holds the lease.
    if (!this.holdLease(Date.now())) {
      this.runController?.abort();
      return;
    }
    const claim = this.claim(sendId);
    if (claim === "delivered") {
      post({ type: "delivered", sendId });
      return;
    }
    // Another process of this session is delivering it.
    if (claim === "theirs") return;
    this.delivering.add(sendId);
    const queued = this.options.target.isBusy();
    post({ type: "deliver_accepted", sendId, queued });
    this.log(`delivering ${sendId}${queued ? " (queued behind a running turn)" : ""}`);
    void this.options.target
      .deliver(text, sendId)
      .then(() => {
        this.markDelivered(sendId);
        post({ type: "delivered", sendId });
        this.log(`delivered ${sendId}`);
      })
      .catch((error: unknown) => {
        this.releaseClaim(sendId);
        // The session ended under it: the hub keeps the send for when it is back.
        if (this.disposed) return;
        post({ type: "deliver_failed", sendId, reason: errorText(error) });
      })
      .finally(() => this.delivering.delete(sendId));
  }
}

interface SnapshotsLease {
  owner: string | null;
  at: number;
  touchedAt: number;
}

function parseLease(text: string | null): SnapshotsLease | null {
  try {
    const value = JSON.parse(text ?? "") as Record<string, unknown>;
    if (typeof value.at !== "number") return null;
    return {
      owner: typeof value.owner === "string" && value.owner ? value.owner : null,
      at: value.at,
      touchedAt: typeof value.touchedAt === "number" ? value.touchedAt : 0,
    };
  } catch {
    return null;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function writeLease(file: string, lease: SnapshotsLease): void {
  try {
    mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(lease), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // Unwritable: the claim still keeps every delivery once.
  }
}
