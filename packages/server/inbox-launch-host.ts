/**
 * One agent the Inbox can start from compose (launch, PR 4a). The engine
 * (inbox-launch.ts) holds the thread, the record, the routes, respawn on a
 * reply, the caches and the run line; everything that knows how one agent
 * works sits behind this interface, in that agent's own file:
 *
 *   inbox-launch-claude.ts             Claude Code (`claude --bg`, its settings file, trust)
 *   inbox-launch-claude-permission.ts  Claude Code's permission hook, key and leases
 *   inbox-launch-pi.ts                 Pi (`pi --mode rpc`, one process per session, owned by the Inbox)
 *
 * The engine holds `{ "claude-code": claude, pi }`. Adding an agent is one host
 * file and its entry there. No host reads another host's state, and nothing
 * outside a host names its CLI.
 */

import type { InboxLaunchAgent, InboxLaunchError, InboxLaunchRecord, InboxMessage } from "@plannotator/core/inbox-types";
import type { InboxRunHostState } from "@plannotator/core/inbox-run-line";
import type { resolveInboxLaunch } from "@plannotator/shared/config";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { AgentEnvironment } from "./inbox-agents";
import type { LaunchEnv } from "./inbox-launch-env";

/** Whether To may offer the agent: `missing` when its CLI is not there at all (the run line's screen 15). */
export type LaunchAvailability = { ok: true; version: string } | { ok: false; missing: boolean; reason: string };

/** What one host call did, for the launch's start.log: its exit code and what it printed. */
export interface LaunchHostResult {
  exitCode: number;
  text: string;
}

/** Why a start or a restart did not take, in words for the run line. */
export type LaunchStartFailure = { code: InboxLaunchError["code"]; text: string };

/** The session connected to the Inbox now: its turn state, and a count that rises whenever it shows new life. */
export interface LaunchLive {
  busy: boolean | null;
  busySince: number | null;
  polls: number;
}

/** One read of every session the host knows: a session's state by its `session_ref`, `absent` when not listed. */
export type LaunchSessions = (ref: string) => InboxRunHostState;

/** What the engine gives a host when it makes it (one per Inbox). */
export interface LaunchHostContext {
  dataDir: string;
  homeDir: string;
  platform: NodeJS.Platform;
  /** The argv that runs this Plannotator (a hook's command). */
  selfCommand: readonly string[];
  /** The Inbox's own env. */
  ownEnv: () => Readonly<Record<string, string | undefined>>;
  /** The env every call but a start runs with: the Inbox's, through the launch filter, its PATH then the last login PATH and `installDirs`. */
  environment: () => Promise<AgentEnvironment>;
  /** The last login-shell read, only the names hosts keep (`shellNames`); null before the first read. */
  shell: () => Readonly<LaunchEnv> | null;
  /**
   * A fresh login-shell read (shared with one under way), for a host that starts its own process again on a
   * reply (`resume`), as `start` gets it. Never held: use it for that start only.
   */
  loginEnv: () => Promise<LaunchEnv>;
  /** config.json's `inboxLaunch`. */
  config: () => ReturnType<typeof resolveInboxLaunch>;
  /** `<dataDir>/inbox/launch/<id>`: the launch's own files. */
  launchDir: (id: string) => string;
  /** One entry in `launch/<id>/start.log`, for the person reading it by hand. */
  startLog: (id: string, text: string) => void;
  /** A folder as the person reads it (`~/…`). */
  displayFolder: (path: string) => string;
  /** The mod's bridge poll (createInboxLaunch's `live`), for a host whose sessions connect through the mod. */
  bridge: { runStateOf(session: string): LaunchLive | null };
  log: (line: string) => void;
}

/** What the engine gives a host's permission transport: its own launches only. */
export interface LaunchPermissionContext {
  store: InboxStore;
  /** `<dataDir>/inbox/launch/<id>`. */
  launchDir: (launchId: string) => string;
  /** The launched root of an id that is not deleted, or null. */
  rootOf: (launchId: string) => InboxMessage | null;
  /** Every launched root that is not deleted. */
  roots: () => InboxMessage[];
  /** A folder as the person reads it (`~/…`). */
  displayFolder: (path: string) => string;
  /** The host's last word on a session (`sessions`, cached) and when it was read. */
  host: { stateOf: (ref: string | null) => InboxRunHostState | null; readAt: () => number };
  onChange: () => void;
  now?: () => number;
  log?: (line: string) => void;
}

/** How a host's permission prompts reach the thread's card (questions written with inbox-launch-permission.ts). */
export interface LaunchHostPermissions {
  /** The agent's own call in (`POST /api/inbox/launch/:id/permission`, after the bridge's guard). None: its prompts are pushed. */
  handle?(req: Request, launchId: string): Promise<Response>;
  /** Every second while launch is on. */
  sweep(): void;
  /** Stop, Delete, launch off: every open question of the launch is withdrawn now. */
  withdrawAll(root: InboxMessage): void;
  // Only a host whose `sessions` show its own prompt (Claude Code): the engine reads them around a question.
  /** A question waits: the host's view is worth reading (did the person answer it in Terminal meanwhile?). */
  holds?(launchId: string): boolean;
  /** A host read made before this still shows the prompt just answered (it counts for nothing), or null. */
  settledAfter?(launchId: string): number | null;
  /** An answer settled since a host read made at `readAt`: one more read says where the session is. */
  readDue?(readAt: number): boolean;
  /** A deleted launch: nothing kept for it. */
  forget?(launchId: string): void;
}

export interface LaunchHost {
  /** `record.agent`, the root's `to.host`, its permission questions' author. */
  readonly agent: InboxLaunchAgent;
  /** "Claude Code": To's row, a refusal, the questions' author. */
  readonly name: string;
  /** The login-shell names it keeps from each read (the rest of the env is never held). */
  readonly shellNames: readonly string[];
  /** Whether To may offer it. The engine caches it 30 s. */
  available(): Promise<LaunchAvailability>;
  /** How a launch made now in `folder` starts; fixed on the record at Send. */
  startOf(folder: string): { full: boolean; ownMode: boolean; bypass: boolean };
  /** It starts in `folder` (and every scratch folder in it) without a trust prompt. */
  trusts(folder: string): boolean;
  /**
   * Make the session for a launch, with the person's login env. No first turn: the root is moved to the
   * session (`settleLaunch`) and its own channel delivers it. It writes its own start.log entries.
   */
  start(launch: InboxLaunchRecord, input: { name: string; login: LaunchEnv }): Promise<{ ok: true; session: string; ref: string } | ({ ok: false } & LaunchStartFailure)>;
  /** Every session it knows, read once (the engine caches it 10 s, and only while a line could change); null when it could not be read. */
  sessions(): Promise<LaunchSessions | null>;
  /** The session connected to the Inbox now; null when not. `polls` must rise whenever it shows new life (Stop waits for a higher count). */
  live(session: string): LaunchLive | null;
  /** Start a session that is not live again (a reply to it, Try again). `failure` when it did not take. */
  resume(launch: InboxLaunchRecord): Promise<LaunchHostResult & { failure: { code: "untrusted" | "failed"; text: string } | null }>;
  stop(ref: string): Promise<LaunchHostResult>;
  /** Delete, after stop: the host forgets the session. */
  remove(ref: string): Promise<LaunchHostResult>;
  /** Delete of a scratch folder: everything the agent keeps for that folder. Never a project folder. `skipped`: why it was not run. */
  purge(folder: string): Promise<LaunchHostResult & { skipped?: string }>;
  /** The command that opens the session in a terminal (⋯'s Copy attach command); null before it exists. */
  attach(launch: InboxLaunchRecord): string | null;
  /** What Open in Terminal runs: the attach command, else (no session, or `untrusted`) what lets the person trust the folder. */
  terminal(launch: InboxLaunchRecord, untrusted: boolean): string;
  /** Its permission transport, made once. */
  permissions(context: LaunchPermissionContext): LaunchHostPermissions;
  /**
   * The words after "<name> stopped." on a launch's line when its session stopped without the person's Stop
   * (why, and what a reply does). Null, or no `stoppedNote`: "Your reply starts it again." (Claude Code).
   */
  stoppedNote?(launch: InboxLaunchRecord): string | null;
  /** The Inbox stops: let go of what this host holds (a connection, the processes it owns). No `close`: it holds nothing. */
  close?(): void;
}
