/**
 * One agent the Inbox can start from compose (launch, PR 4a). The engine
 * (inbox-launch.ts) holds the thread, the record, the routes, respawn on a
 * reply, the caches and the run line; everything that knows how one agent
 * works sits behind this interface, in that agent's own file:
 *
 *   inbox-launch-claude.ts             Claude Code (`claude --bg`, its settings file, trust)
 *   inbox-launch-claude-permission.ts  Claude Code's permission hook, key and leases
 *   inbox-launch-pi.ts                 Pi (`pi --mode rpc`, one process per session, owned by the Inbox)
 *   inbox-launch-codex.ts              Codex (`codex app-server`, one process per thread, owned by the Inbox)
 *   inbox-launch-codex-permission.ts   Codex's approval requests on the permission card
 *   inbox-launch-opencode.ts           OpenCode 2 (`opencode2 serve`, one per session, owned by the Inbox)
 *   inbox-launch-t3.ts                 Any of them started in T3 Code instead (`t3 thread start`, a thread T3 owns)
 *
 * The engine holds `{ "claude-code": claude, pi, codex, opencode }`, and T3 Code's apart: it is no agent of
 * its own, it runs a launch that asked for T3 Code ("Start new agents in"). Adding an agent is one host
 * file and its entry there. No host reads another host's state, and nothing
 * outside a host names its CLI.
 */

import { join } from "node:path";
import type { INBOX_T3_HOST, InboxLaunchAgent, InboxLaunchError, InboxLaunchInner, InboxLaunchNotReady, InboxLaunchRecord, InboxMessage } from "@plannotator/core/inbox-types";
import type { InboxRunHostState } from "@plannotator/core/inbox-run-line";
import type { InboxLaunchChoices } from "@plannotator/core/inbox-launch-choice";
import type { resolveInboxLaunch } from "@plannotator/shared/config";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { INBOX_UPLOADS_DIR } from "@plannotator/shared/inbox/uploads";
import type { AgentEnvironment } from "./inbox-agents";
import type { LaunchEnv } from "./inbox-launch-env";

/**
 * Whether To may offer the agent: `missing` when its CLI is not there at all (the run line's screen 15). `code`: why,
 * for a linked machine's window to say it with this machine's name (remote launch); absent from a host that has none.
 */
export type LaunchAvailability = { ok: true; version: string } | { ok: false; missing: boolean; reason: string; code?: InboxLaunchNotReady };

/** What one host call did, for the launch's start.log: its exit code and what it printed. */
export interface LaunchHostResult {
  exitCode: number;
  text: string;
}

/**
 * What a host did with the Inbox's wake text for one of its sessions (`deliver`): it went in as a turn
 * (`delivered`, recorded at once), the wake's own way should carry it (`queue`: `codex queue`, for a session no
 * launch of this Inbox owns), it could not (`failed`: tried again later, as a failed `codex queue` is), or it may
 * have gone (`uncertain`: sent and never answered; kept claimed and never sent again, as a `codex queue` that ran
 * out of time is). `hold` (the engine's answer, never a host's): not now, and not the wake's own way either; the
 * item waits in the Inbox (a deleted launch's session, a reply the person's Stop held).
 */
export type LaunchDelivery = "delivered" | "queue" | "hold" | { failed: string } | { uncertain: string };

/**
 * The folder the person's files sent to an agent sit in (a message's `attachments`). A launched session reads them
 * outside its own folder, so each host gives it read access here: a prompt for its own message's file serves no one.
 */
export const launchUploadsDir = (dataDir: string) => join(inboxDir(dataDir), INBOX_UPLOADS_DIR);

/** A word that is a link: cut inside it, it would be a link to somewhere else. */
const LINK_WORD = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i;

/**
 * Text from an agent as a thread note quotes it: one line, controls and invisible characters dropped, Markdown's
 * marks escaped, `max` characters at most. What a note quotes comes from the agent or its provider, never the person.
 * `words`: a cut falls between words when the last one starts in the second half of the room (else through it), and
 * never inside a link, which goes whole.
 */
export function launchNoteText(text: unknown, max: number, options: { words?: boolean } = {}): string {
  const flat = String(typeof text === "string" ? text : "")
    // Controls, bidi and other invisible format characters go; the zero-width joiner stays (it holds an emoji together).
    .replace(/(?:(?!‍)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}])+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...flat];
  let short = flat;
  if (chars.length > max) {
    let end = max - 1;
    if (options.words && chars[end] !== " ") {
      const space = chars.lastIndexOf(" ", end - 1);
      const next = chars.indexOf(" ", end);
      const word = chars.slice(space + 1, next === -1 ? chars.length : next).join("");
      if (LINK_WORD.test(word) || space >= end / 2) end = Math.max(space, 0);
    }
    short = `${chars.slice(0, end).join("").trimEnd()}…`;
  }
  // Only marks the Inbox's inline Markdown both formats and unescapes (InlineMarkdown's
  // backslash rule): an escaped `:` or `<` would show its backslash; React keeps `<` text.
  return short.replace(/[\\`*_[\]~#>|$!&{}]/g, (mark) => `\\${mark}`);
}

/** The most of an agent's own error a failed turn's note quotes. */
export const LAUNCH_TURN_ERROR_MAX = 300;

/**
 * The note a launched session's failed turn leaves in its thread (Codex, Pi, Claude Code): "<name>'s turn ended with
 * an error: <the agent's own words>", one line, LAUNCH_TURN_ERROR_MAX characters at most, cut between words.
 */
export function launchTurnErrorNote(name: string, error: string): string {
  const shown = launchNoteText(error, LAUNCH_TURN_ERROR_MAX, { words: true });
  return shown ? `${name}'s turn ended with an error: ${shown}` : `${name}'s turn ended with an error.`;
}

/**
 * A launched session's last turn ended in an error the session itself wrote down (Claude Code's transcript): `key`
 * names that entry (one note per entry, however often it is read), `text` is the agent's own words, `at` when (ms).
 */
export interface LaunchTurnError {
  key: string;
  text: string;
  at: number;
}

/**
 * One note from a launched session in its thread (a turn that failed, a dialog answered Cancel), under the thread's
 * latest message. A note that can't be written is logged and goes no further: it never ends what it reports on.
 */
export function writeLaunchNote(
  context: Pick<LaunchPermissionContext, "store" | "onChange">,
  root: InboxMessage,
  note: { author: { host: string; session: string; name: string }; body: string; key: string; turnError?: boolean },
  log: (line: string) => void,
): void {
  try {
    const latest = context.store.threadMessageIds(root.thread_id).at(-1) ?? root.id;
    context.store.sendMessage({
      project_id: root.project_id,
      author: { kind: "agent", ...note.author },
      body: note.body,
      reply_to: latest,
      idempotency_key: note.key,
      // The Inbox's own note: the sound never rings for it, except a failed turn's (`InboxMessage.launch_note`).
      launch_note: true,
      // A failed turn's note: the window notifies for it (`InboxMessage.turn_error`).
      ...(note.turnError ? { turn_error: true } : {}),
    });
    context.onChange();
  } catch (error) {
    log(`Inbox launch ${root.launch?.id ?? root.id}: a note was not written: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Why a start or a restart did not take, in words for the run line. */
export type LaunchStartFailure = { code: InboxLaunchError["code"]; text: string };

/**
 * Why a start in T3 Code made nothing, so the agent starts in the background instead: `absent`, T3 Code isn't open on
 * this computer (or its `t3` is not here); `refused`, T3 said no (no model for that agent, a refused start).
 */
export type LaunchStartAway = "absent" | "refused";

/**
 * T3 Code only, what it refused (the run line says it): `no_model`, it has no model for that agent; `project`, it didn't
 * add the folder. `declined` beside it: the model T3 didn't take; `declined_effort`, the effort.
 */
export type LaunchStartWhy = "no_model" | "project";

/** What trusting a folder turns on, read from its files now. */
export interface LaunchTrustReading {
  /** The run line's one plain line on what would run once trusted, or null when there is nothing to say. */
  warning: string | null;
  /** Compose's short lines: none for a clean folder. */
  facts: string[];
  /** A fact beyond "the whole repository": something would run or reach out, or could not be read. */
  warns: boolean;
}

/** The folder a trust is asked for: a launch's, or compose's pick before there is a launch (`scratch: false`). */
export type LaunchTrustTarget = Pick<InboxLaunchRecord, "folder" | "scratch">;

/**
 * The owner's one press on a folder the agent does not trust: compose's Trust and start, and the run line's Trust
 * folder. Making one reads no warning, so compose can ask for every project on its 5 s refresh.
 */
export interface LaunchTrustOffer {
  /** The folder the trust lands on, which may not be the one picked (a repository's root, a scratch root). */
  folder: string;
  /** Reads the folder's files now. */
  read(): LaunchTrustReading;
  /** Saves the trust; throws with words for the person, nothing changed. `allowed`: asked under the host's own lock, just before the write; no saves nothing. */
  accept(allowed?: () => boolean): Promise<void>;
}

/** The session connected to the Inbox now: its turn state, and a count that rises whenever it shows new life. */
export interface LaunchLive {
  busy: boolean | null;
  busySince: number | null;
  polls: number;
  /** When its current idle spell began (null while busy or not known): a new value is a turn that ended. */
  idleSince?: number | null;
  /** How many items it took as a turn: a new value is a turn that began, even one too short to be said busy. */
  taken?: number;
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
  /**
   * Whether an agent session belongs elsewhere than launch `launchId`: another launch (deleted or not) started it, or
   * its first message in this Inbox (one it wrote, or a person's that went to it) is in another thread than that
   * launch's. A host that picks up a session a cut-short start may have made (T3 Code) never takes one of those, and
   * still takes its own launch's, whose agent may have written in that launch's thread already.
   */
  sessionElsewhere?: (session: string, launchId: string) => boolean;
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
  /** `record.agent`, the root's `to.host`, its permission questions' author. T3 Code's (`t3`) is only ever a session's host. */
  readonly agent: InboxLaunchAgent | typeof INBOX_T3_HOST;
  /** "Claude Code": To's row, a refusal, the questions' author. */
  readonly name: string;
  /** What of Plannotator's connects a session, in the line's words: "plugin" (the default), Pi's "extension". */
  readonly connector?: string;
  /** The login-shell names it keeps from each read (the rest of the env is held only by a host with `loginRead`). */
  readonly shellNames: readonly string[];
  /** Login-shell names it learns only whether they are set: kept as "1", never their values (a sign-in token). */
  readonly shellFlags?: readonly string[];
  /**
   * Each login read's whole env, as read (a stand-in from a shell that did not answer included: the host tells them
   * apart with `LOGIN_ENV_FALLBACKS`). OpenCode holds it in memory for its model-list reads, so they see what the
   * session sees (a key exported in the shell rc) without running the shell again. Never written, never logged.
   */
  loginRead?(login: Readonly<LaunchEnv>): void;
  /**
   * Whether To may offer it. The engine caches it 30 s. `folders`: whether it can start in at least one of these
   * (already checked) folders, by their own settings where the host reads any (Claude Code's project plugin
   * scopes); not cached. None: the machine's own setup.
   */
  available(folders?: readonly string[]): Promise<LaunchAvailability>;
  /**
   * Its model lists; OpenCode's may instead say why they could not be read (`unread`, lists empty). `defaultIn`: the
   * folder picked in To (null: the home folder), for a host that names its default model for it (OpenCode: never by
   * running anything there); absent, none.
   */
  choices?(options?: { defaultIn?: string | null }): Promise<Omit<InboxLaunchChoices, "last"> | null>;
  /** What compose gets while `choices` takes longer than the offer's wait (OpenCode: `reading`). None: no lists. */
  readonly choicesWhileReading?: Omit<InboxLaunchChoices, "last">;
  /** How a launch made now in `folder` starts; fixed on the record at Send. */
  startOf(folder: string): { full: boolean; ownMode: boolean; bypass: boolean };
  /** It starts in `folder` (and every scratch folder in it) without a trust prompt. */
  trusts(folder: string): boolean;
  /** Trust this folder from the Inbox, when the host can: null, or no member, leaves Open in Terminal alone. */
  trustOffer?(target: LaunchTrustTarget): LaunchTrustOffer | null;
  /** The launch's folder is the file-system root, or its trust would land on a repository rooted at home: accepting the agent's own prompt there would trust all of home (or `/`), so the how-to steers away from it. */
  trustCoversHome?(target: LaunchTrustTarget): boolean;
  /**
   * Only a host that cannot make a session without its first message (T3 Code's `t3 thread start`): `start` gets
   * the wake text of the launched message (`firstTurn`, what the agent's own wake would send it) and puts it in as
   * the session's first turn. On success the engine records the root as delivered to the session in the same step
   * that moves it there, so no wake sends it again.
   */
  readonly startsWithTurn?: boolean;
  /**
   * Only a host whose start can't be picked up again once the Inbox stops mid-start (T3 Code): the run line's cause
   * for a launch with no session and no error that no start runs for now. Its Try again starts it again (`start`
   * finds a thread the cut start made). No member: the generic "not connected" line.
   */
  readonly interruptedStart?: string;
  /**
   * Only a host whose start puts the first turn in itself, so the root is delivered before its session ever reached
   * the Inbox (T3 Code): how long after the start the run line waits for the session to poll, call a tool or write,
   * before it says it is not connected. No member: delivered means connected.
   */
  readonly connectWaitMs?: number;
  /**
   * Only a `connectWaitMs` host: whether the session's turn has ended, as its own app says (T3 Code's `thread show`):
   * true when it ended (or never ran), false while a turn runs or waits on the person there, null when the app can't
   * be asked. The "not connected" line shows only on true or null: a session at work is never called not connected.
   */
  turnEnded?(ref: string): Promise<boolean | "failed" | null>;
  /**
   * Make the session for a launch, with the person's login env. No first turn: the root is moved to the
   * session (`settleLaunch`) and its own channel delivers it (but see `startsWithTurn`). It writes its own start.log entries.
   * `wrote`: the agent of an earlier, cut-short start already wrote in the launch's thread (T3 Code): take that session,
   * never start a second.
   */
  start(
    launch: InboxLaunchRecord,
    input: { name: string; login: LaunchEnv; firstTurn?: string; wrote?: boolean },
  ): Promise<{ ok: true; session: string; ref: string; inner?: InboxLaunchInner; declined?: string; declined_effort?: string } | ({ ok: false; away?: LaunchStartAway; why?: LaunchStartWhy; declined?: string; declined_effort?: string } & LaunchStartFailure)>;
  /**
   * Start in Rex (Settings → Agents' "Start new agents in"): the agent's ordinary interactive command, for a Rex tab
   * to run through the person's login shell. Only a host whose interactive session connects to the Inbox by itself
   * at its start, as the session id given here (so the root, addressed to it, is its first turn through its own
   * channel, as for `start`): never the person's message on the command line. `resume`: the same session again (a
   * reply to one that ended). `fresh` with it: that session never took a turn (it never connected: stopped at a
   * prompt in its tab), so there is nothing to resume: it starts on its own id as a first start does, named (Claude
   * Code's `--session-id`, not `--resume`). It writes what the session needs (Claude Code's settings file), or makes the session
   * first when only the agent's server can (OpenCode: a short server of its own, ended before the tab opens); the
   * agent itself runs only in the tab. No member: this agent always starts in the background (Codex: a Codex in a tab
   * never tells the Inbox between turns whether it runs, so its line could not say).
   */
  rexCommand?(launch: InboxLaunchRecord, input: { name: string; login: LaunchEnv; resume: boolean; fresh?: boolean }): Promise<{ ok: true; session: string; ref: string; command: string } | ({ ok: false } & LaunchStartFailure)>;
  /**
   * Start in Rex: whether a process on this computer runs `session`, by `listing` (`ps -A -o pid=,ppid=,command=`),
   * for an agent whose running process does not keep its argv (Pi sets `process.title`). No member: its argv names
   * the session (inbox-rex-resume.ts reads it).
   */
  runsSession?(session: string, listing: string): boolean;
  /**
   * The processes in `listing` that run `session` (the same check as `runsSession`, as pids), for Stop of an agent in
   * a Rex pane the Inbox did not open: only ones it is sure are that agent now (a signal goes to each). No member: its
   * argv names the session (inbox-rex-resume.ts finds them).
   */
  sessionPids?(session: string, listing: string): number[] | Promise<number[]>;
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
  /** That command never reached Terminal (osascript failed): undo what `terminal` did for it. */
  terminalFailed?(launch: InboxLaunchRecord, command: string): void;
  /**
   * A host that owns its session's process: true when no process of its own runs this session now (it ended,
   * or this Inbox never ran one). A reply then starts it again even if it never connected. No member: a
   * session that never connected is never started again by a reply.
   */
  processEnded?(ref: string): boolean;
  /** Its permission transport, made once. */
  permissions(context: LaunchPermissionContext): LaunchHostPermissions;
  /**
   * The words after "<name> stopped." on a launch's line when its session stopped without the person's Stop
   * (why, and what a reply does). Null, or no `stoppedNote`: "Your reply starts it again." (Claude Code).
   */
  stoppedNote?(launch: InboxLaunchRecord): string | null;
  /**
   * Only a host whose sessions the Inbox wakes itself (Codex: inbox-codex-wake.ts, no plugin poll): the wake text of
   * a person's item for a launched session goes in as that session's turn. Without it, the wake's own way. `signal`:
   * the person pressed Stop or Delete meanwhile (the engine waits for this call before it stops the session): start
   * no turn after it.
   */
  deliver?(launch: InboxLaunchRecord, text: string, signal: AbortSignal): Promise<LaunchDelivery>;
  /**
   * Only a host whose session writes its failed turns down where the Inbox can read them (Claude Code's transcript)
   * and says nothing to the Inbox itself: the error the session's last turn ended in, or null (it ended well, a new
   * turn began, nothing could be read). The engine asks only for a session this Inbox launched, while it is idle.
   */
  turnError?(launch: InboxLaunchRecord, session: string): LaunchTurnError | null;
  /** The Inbox stops: let go of what this host holds (a connection, the processes it owns). No `close`: it holds nothing. */
  close?(): void;
}
