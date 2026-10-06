/**
 * The `plannotator` agent tool on OpenCode 2 (contract:
 * `packages/shared/plannotator-tool.ts`, the same one the Claude Code mod
 * registers), plus the record of the reviews each OpenCode session opened.
 *
 * Open actions (annotate, review, last) go through the SAME launch the native
 * slash commands use (`runNativeCommand` -> `handleCliCommand`: a `plannotator`
 * CLI child, the pull-bridge token for "Ask this session", the ready file, the
 * decision delivered later to the session with `session.prompt`). The tool
 * returns as soon as the server is up, with the session id and the url, while
 * the child keeps running in the background.
 *
 * `list` and `close` see only the reviews THIS OpenCode session opened (tool
 * calls, its slash commands, and its plan review), from the plugin's own
 * record: never the global `sessions/` registry. Closing calls the CLI's
 * host-only `POST /api/host/close` with the launch's token (the reviewer's
 * Close, draft kept, the tab told). Only a server that answered as an older
 * Plannotator without the endpoint is stopped instead, with SIGTERM to the
 * plugin's own child process; a server that does not answer, refuses, or runs
 * in remote mode is left running.
 *
 * Plan review is not part of the tool: it stays on `submit_plan`.
 */

import { randomBytes } from "node:crypto";
import path from "node:path";
import type { ParsedAnnotateArgs } from "@plannotator/shared/annotate-args";
import {
  HOST_CLOSE_PATH,
  HOST_STATUS_PATH,
  classifyHostCloseAnswer,
  readHostStatusAnswer,
  type HostHttpAnswer,
} from "@plannotator/shared/host-control";
import {
  PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT,
  parsePlannotatorToolInput,
  plannotatorDistinctSubjects,
  plannotatorSessionId,
  plannotatorToolArgs,
  plannotatorToolCloseText,
  plannotatorToolListText,
  plannotatorToolOpenedText,
  plannotatorDecisionHeading,
  plannotatorBundleSubject,
  plannotatorTargetSubject,
  looksLikeFilePath,
  plannotatorToolTargets,
  plannotatorUnknownSessionText,
  type PlannotatorCloseOutcome,
  type PlannotatorSessionSummary,
  type PlannotatorToolInput,
} from "@plannotator/shared/plannotator-tool";
import type { CliLaunch } from "./cli-bridge";

export type LaunchKind = "plan" | "annotate" | "review" | "last";

/** One review an OpenCode session opened, while it is open. */
export interface TrackedLaunch {
  /** `pn-` + 6 hex. */
  readonly id: string;
  /** The OpenCode session that opened it; `list` and `close` filter on it. */
  readonly owner: string;
  readonly kind: LaunchKind;
  /** How it is named: `baseSubject`, told apart from the owner's same-named open launches. */
  subject: string;
  /** The subject before same-named launches were told apart: from the typed words, then from what the server opened. */
  baseSubject: string;
  /** What it shows, in full, once its server named it (the ready file). */
  target?: string | string[];
  readonly startedAt: number;
  url?: string;
  port?: number;
  isRemote?: boolean;
  /** The host-control token the CLI child was started with (its pull-bridge token). */
  token?: string;
  /** SIGTERM the plugin's own child; the older-CLI close fallback only. */
  terminate?: () => boolean;
  closedByAgent: boolean;
}

/** How a launch's start went, as the tool waits for it. */
export type LaunchStart =
  | { state: "ready"; url: string }
  | { state: "failed"; message: string }
  /** The command ended without opening a page and without saying why. */
  | { state: "ended" };

export interface LaunchHandle {
  readonly launch: TrackedLaunch;
  /** Hand this to `handleCliCommand` (or a plan review's ready hook). */
  readonly observer: CliLaunch;
  /** Settles once: the server is up, the command failed, or it ended. */
  readonly started: Promise<LaunchStart>;
  /** The command is over (decision delivered or not, or failed): forget the launch. */
  end(): void;
}

/**
 * The plugin's record of open reviews, keyed by session id. One per plugin
 * instance; entries live from launch to the end of the command.
 */
export class OpenCodeLaunchRegistry {
  private readonly launches = new Map<string, TrackedLaunch>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly randomHex: () => string = () => randomBytes(3).toString("hex"),
  ) {}

  /** A fresh `pn-` id, unique among the open launches of every session. */
  private nextId(): string {
    for (let attempt = 0; attempt < 64; attempt++) {
      const id = plannotatorSessionId(this.randomHex());
      if (!this.launches.has(id)) return id;
    }
    throw new Error("Could not allocate a Plannotator session id.");
  }

  begin(owner: string, kind: LaunchKind, subject: string, options: { deliverApproval?: boolean } = {}): LaunchHandle {
    const launch: TrackedLaunch = {
      id: this.nextId(),
      owner,
      kind,
      subject,
      baseSubject: subject,
      startedAt: this.now(),
      closedByAgent: false,
    };
    this.launches.set(launch.id, launch);

    let settle!: (start: LaunchStart) => void;
    let settled = false;
    const started = new Promise<LaunchStart>((resolve) => {
      settle = (start) => {
        if (settled) return;
        settled = true;
        resolve(start);
      };
    });

    const observer: CliLaunch = {
      sessionId: launch.id,
      // Read when the decision is delivered: the subject may have been told
      // apart from a same-named launch since, and the target learned.
      get subject() {
        return launch.subject;
      },
      get target() {
        return launch.target;
      },
      ...(options.deliverApproval ? { deliverApproval: true } : {}),
      onSpawn: ({ token, terminate }) => {
        launch.token = token;
        launch.terminate = terminate;
      },
      onServer: ({ url, port, isRemote, target }) => {
        launch.url = url;
        launch.port = port ?? portFromUrl(url);
        launch.isRemote = isRemote;
        if (target !== undefined) {
          launch.target = target;
          // Named by what the CLI opened, not the typed words: it drops a
          // stray `.` or prose beside a file (`annotate . a.md` opens a.md).
          const named = subjectFromServerTarget(kind, launch.baseSubject, target);
          if (named !== null) launch.baseSubject = named;
          this.relabel(owner);
        }
        settle({ state: "ready", url });
      },
      onFailure: (message) => settle({ state: "failed", message }),
      isClosedByAgent: () => launch.closedByAgent,
    };

    return {
      launch,
      observer,
      started,
      end: () => {
        this.launches.delete(launch.id);
        settle({ state: "ended" });
      },
    };
  }

  /** Tell `owner`'s same-named open launches apart by enough of their paths (`a/QUESTIONS.md`). */
  private relabel(owner: string): void {
    const open = this.openFor(owner);
    const subjects = plannotatorDistinctSubjects(
      open.map((launch) => ({ subject: launch.baseSubject, ...(launch.target !== undefined ? { target: launch.target } : {}) })),
    );
    open.forEach((launch, index) => {
      launch.subject = subjects[index] ?? launch.subject;
    });
  }

  /** The reviews `owner` opened that are still open (not ended, not closed by the agent). */
  openFor(owner: string): TrackedLaunch[] {
    return [...this.launches.values()].filter((launch) => launch.owner === owner && !launch.closedByAgent);
  }
}

/** The port of a loopback url, for a CLI whose ready file carries none. */
function portFromUrl(url: string): number | undefined {
  try {
    const parsed = new URL(url);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return undefined;
    const port = Number(parsed.port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

function baseName(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  return path.basename(trimmed) || trimmed;
}

const PR_URL = /^https?:\/\/[^\s/]+\/.+\/(?:pull|pull-requests|merge_requests)\/(\d+)\b/i;

/** What a review shows, from its target words (directory or PR URL). */
function reviewSubject(words: readonly string[]): string {
  for (const word of words) {
    const match = PR_URL.exec(word);
    if (match) return /merge_requests/i.test(word) ? `MR !${match[1]}` : `PR #${match[1]}`;
  }
  const directory = words[words.length - 1];
  return directory ? `changes in ${baseName(directory)}` : LOCAL_CHANGES_SUBJECT;
}

/** A review of the session's own working tree, opened with no target words. */
const LOCAL_CHANGES_SUBJECT = "local changes";

/**
 * The subject a launch takes once its server names the target it opened, or
 * null to keep `typed` (from the typed words; all an older CLI leaves).
 * Annotate and review are named from the target; plan and last keep theirs,
 * and a review typed with no target stays "local changes". The Claude Code
 * mod's rule (apps/hook/hooks/mod/launch.ts).
 */
export function subjectFromServerTarget(kind: LaunchKind, typed: string, target: string | readonly string[]): string | null {
  if (kind === "plan" || kind === "last") return null;
  if (kind === "review" && typed === LOCAL_CHANGES_SUBJECT) return null;
  return plannotatorTargetSubject(kind, target);
}

/** What an annotate session shows, from its target words. */
function annotateSubject(words: readonly string[]): string {
  const target = words.find((word) => /^https?:\/\//i.test(word) || /[./\\]/.test(word)) ?? words[0];
  if (!target) return "document";
  if (/^https?:\/\//i.test(target)) {
    try {
      return new URL(target).host;
    } catch {
      return target;
    }
  }
  return baseName(target.replace(/^@/, ""));
}

const LAST_SUBJECT = "your last message";

/** The subject a slash command's launch is listed and headed under. */
export function commandSubject(command: string, rawArgs: string): { kind: LaunchKind; subject: string } | null {
  const words = rawArgs.trim().split(/\s+/).filter((word) => word && !word.startsWith("-"));
  switch (command) {
    case "plannotator-annotate": {
      // Several file paths open as one review: name it as a bundle (the mod's rule).
      const distinct = [...new Set(words)];
      if (distinct.length > 1 && distinct.every(looksLikeFilePath)) {
        return { kind: "annotate", subject: plannotatorBundleSubject(distinct) };
      }
      return { kind: "annotate", subject: annotateSubject(words) };
    }
    case "plannotator-review": {
      // `--base <ref>` / `--diff-type <id>` take a value that is not a target.
      const all = rawArgs.trim().split(/\s+/).filter(Boolean);
      const targets: string[] = [];
      for (let index = 0; index < all.length; index++) {
        const word = all[index] as string;
        if (word === "--base" || word === "--diff-type") {
          index++;
          continue;
        }
        if (!word.startsWith("-")) targets.push(word);
      }
      return { kind: "review", subject: reviewSubject(targets) };
    }
    case "plannotator-last":
      return { kind: "last", subject: LAST_SUBJECT };
    default:
      return null;
  }
}

/** The subject of a tool call's launch. */
export function toolSubject(call: PlannotatorToolInput): string {
  const targets = plannotatorToolTargets(call);
  switch (call.action) {
    case "annotate":
      // A list of files is one review of all of them, named as such.
      return Array.isArray(call.target) ? plannotatorBundleSubject(targets) : annotateSubject(targets);
    case "review":
      return reviewSubject(targets);
    default:
      return LAST_SUBJECT;
  }
}

/**
 * One word for `parseReviewArgs`'s string form, which splits on whitespace and
 * strips one pair of wrapping quotes (no escapes). The tool's words carry no
 * control characters (the contract refuses them); a word holding both quote
 * kinds and whitespace cannot be written and is refused.
 */
export function quoteReviewWord(word: string): string | null {
  if (!/[\s"']/.test(word)) return word;
  if (!word.includes('"')) return `"${word}"`;
  if (!word.includes("'")) return `'${word}'`;
  return null;
}

/** The arguments one tool call's launch runs with. */
export function toolLaunchRequest(call: PlannotatorToolInput):
  | { ok: true; command: string; rawArgs: string; annotateArgs?: ParsedAnnotateArgs; annotateBundle?: string[] }
  | { ok: false; error: string } {
  switch (call.action) {
    case "annotate": {
      const targets = plannotatorToolTargets(call);
      const target = targets[0] as string;
      return {
        ok: true,
        command: "plannotator-annotate",
        rawArgs: targets.join(" "),
        // A list (two or more, the contract drops duplicates): one review of
        // all of them, each its own CLI argument, in the agent's order.
        ...(targets.length > 1 ? { annotateBundle: targets } : {}),
        // One argument whatever it holds: never re-split.
        annotateArgs: {
          filePath: target.replace(/^@/, ""),
          rawFilePath: target,
          gate: call.gate === true,
          json: false,
          hook: false,
          renderHtml: false,
          renderMarkdown: call.options?.markdown === true,
          noJina: false,
          app: false,
          static: false,
        },
      };
    }
    case "review": {
      const words: string[] = [];
      for (const word of plannotatorToolArgs(call)) {
        const quoted = quoteReviewWord(word);
        if (quoted === null) {
          return { ok: false, error: `Invalid plannotator call: "${word}" holds both kinds of quote and a space, which cannot be passed on.` };
        }
        words.push(quoted);
      }
      return { ok: true, command: "plannotator-review", rawArgs: words.join(" ") };
    }
    default:
      return { ok: true, command: "plannotator-last", rawArgs: "" };
  }
}

/** `last` from a subagent: it reads the main session's messages, which the subagent did not write (the mod's wording). */
export const PLANNOTATOR_TOOL_SUBAGENT_LAST_TEXT =
  'Invalid plannotator call: action "last" annotates the main session\'s last message and is not available to a subagent.';

/**
 * The message a launch that answered "starting" sends once its CLI fails
 * after all: the agent was told to wait for a decision that will never come.
 */
export function plannotatorLateFailureText(subject: string, sessionId: string, message: string): string {
  return [
    plannotatorDecisionHeading(subject, sessionId, "Did not open"),
    "",
    `Plannotator could not start: ${message}`,
    `Nothing more arrives for ${sessionId}; do not wait for it.`,
  ].join("\n");
}

/** The session a call's reviews belong to: the root session, and whether the caller is a subagent below it. */
export interface ToolSessionOwner {
  root: string;
  subagent: boolean;
}

export interface PlannotatorToolDeps {
  registry: OpenCodeLaunchRegistry;
  /**
   * Run one tracked launch the way the slash command does (CLI child, pull
   * bridge, decision delivered later). Resolves when the command is over,
   * which is long after the tool has returned.
   */
  launch: (request: {
    sessionID: string;
    command: string;
    rawArgs: string;
    annotateArgs?: ParsedAnnotateArgs;
    /** A list target: the files opened as one review (a bundle), in order. */
    annotateBundle?: readonly string[];
    launch: CliLaunch;
  }) => Promise<void>;
  /**
   * The root session of `sessionID` (a subagent's session has a parent). A
   * subagent's reviews belong to the root session: the decision is delivered
   * there and the main agent lists and closes them, as on the Claude Code mod.
   * Absent or failing: the caller is its own root.
   */
  resolveOwner?: (sessionID: string) => Promise<ToolSessionOwner>;
  /**
   * Tell the session that a launch the tool reported as "starting" did not
   * open after all (`plannotatorLateFailureText`), so neither the agent nor
   * the person waits for a decision that never comes.
   */
  reportLateFailure?: (input: { sessionID: string; text: string }) => Promise<void> | void;
  /** HTTP to the CLI's own server (tests replace it). */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** How long the tool waits for the page before answering "starting". */
  readyWaitMs?: { review: number; other: number };
  now?: () => number;
}

/** Same waits as the Claude Code mod: a review prepares a diff, the rest open fast. */
const READY_WAIT_MS = { review: 45_000, other: 15_000 };
const HOST_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Answer one `plannotator` tool call from the OpenCode session `sessionID`.
 * Always resolves with the text the model reads (an invalid call, a refusal
 * and a startup error included).
 */
export async function runPlannotatorTool(
  input: unknown,
  context: { sessionID: string },
  deps: PlannotatorToolDeps,
): Promise<string> {
  const parsed = parsePlannotatorToolInput(input);
  if (!parsed.ok) return parsed.error;
  const call = parsed.input;
  let owner: ToolSessionOwner = { root: context.sessionID, subagent: false };
  try {
    owner = (await deps.resolveOwner?.(context.sessionID)) ?? owner;
  } catch {
    // Unknown: the caller is its own root, like the slash commands.
  }

  switch (call.action) {
    case "list":
      return await listText(owner.root, deps);
    case "close":
      return await closeText(owner.root, call.session as string, deps);
    case "last":
      if (owner.subagent) return PLANNOTATOR_TOOL_SUBAGENT_LAST_TEXT;
      break;
    case "annotate":
    case "review":
      break;
  }

  const request = toolLaunchRequest(call);
  if (!request.ok) return request.error;

  const gate = call.gate === true;
  const subject = toolSubject(call);
  const handle = deps.registry.begin(owner.root, call.action, subject, { deliverApproval: gate });
  void deps
    .launch({
      // The root session: a subagent's decision lands where the person is.
      sessionID: owner.root,
      command: request.command,
      rawArgs: request.rawArgs,
      ...(request.annotateArgs ? { annotateArgs: request.annotateArgs } : {}),
      ...(request.annotateBundle ? { annotateBundle: request.annotateBundle } : {}),
      launch: handle.observer,
    })
    .catch((error) => {
      handle.observer.onFailure?.(error instanceof Error ? error.message : String(error));
    })
    .finally(() => handle.end());

  const waits = deps.readyWaitMs ?? READY_WAIT_MS;
  const waitMs = call.action === "review" ? waits.review : waits.other;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), waitMs);
  });
  const start = await Promise.race([handle.started, timeout]);
  if (timer !== undefined) clearTimeout(timer);

  if (start === "timeout") {
    // The agent is told to wait. If the CLI then fails before the page opens,
    // tell the session, or it waits for a decision that never comes.
    // Only an explicit failure: a command that ENDS without a ready file can
    // be a CLI too old to write one (before 0.19.24), whose decision was
    // delivered at exit.
    void handle.started.then(async (late) => {
      if (late.state !== "failed") return;
      try {
        await deps.reportLateFailure?.({
          sessionID: owner.root,
          text: plannotatorLateFailureText(subject, handle.launch.id, late.message),
        });
      } catch {
        // Best effort: the failure is already in the plugin's log.
      }
    });
    return plannotatorToolOpenedText(handle.launch.subject, undefined, gate, handle.launch.id, handle.launch.target);
  }
  switch (start.state) {
    case "ready":
      // The server named what it opened, in full; the subject may now be told apart from a same-named review.
      return plannotatorToolOpenedText(handle.launch.subject, start.url, gate, handle.launch.id, handle.launch.target);
    case "failed":
      // An older CLI's answer to a list of files: the update text, as is.
      if (start.message === PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT) return start.message;
      return `Plannotator could not start: ${start.message}`;
    case "ended":
      return "Plannotator could not start: it exited before opening the page.";
  }
}

async function hostRequest(
  launch: TrackedLaunch,
  pathname: string,
  init: RequestInit,
  deps: PlannotatorToolDeps,
): Promise<HostHttpAnswer | null> {
  if (!launch.port) return null;
  const doFetch = deps.fetch ?? ((url: string, options: RequestInit) => fetch(url, options));
  try {
    const response = await doFetch(`http://127.0.0.1:${launch.port}${pathname}`, {
      ...init,
      // No Origin header: the server refuses browser requests here.
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${launch.token ?? ""}` },
      signal: AbortSignal.timeout(HOST_REQUEST_TIMEOUT_MS),
    });
    return { status: response.status, text: await response.text() };
  } catch {
    return null;
  }
}

async function listText(sessionID: string, deps: PlannotatorToolDeps): Promise<string> {
  const now = (deps.now ?? (() => Date.now()))();
  const sessions: PlannotatorSessionSummary[] = [];
  for (const launch of deps.registry.openFor(sessionID)) {
    const status = launch.url ? readHostStatusAnswer(await hostRequest(launch, HOST_STATUS_PATH, { method: "GET" }, deps)) : null;
    sessions.push({
      id: launch.id,
      kind: launch.kind,
      subject: launch.subject,
      ...(launch.url ? { url: launch.url } : {}),
      ageMs: now - launch.startedAt,
      state: !launch.url ? "starting" : status?.decided ? "decided" : "open",
      unsent: status ? status.unsent : null,
    });
  }
  return plannotatorToolListText(sessions);
}

async function closeText(sessionID: string, session: string, deps: PlannotatorToolDeps): Promise<string> {
  const open = deps.registry.openFor(sessionID);
  if (session === "all") {
    const outcomes: PlannotatorCloseOutcome[] = [];
    // "all" means every review that CAN be closed: plan reviews are skipped
    // silently (only an explicit plan id gets the "not closable" line).
    for (const launch of open) {
      if (launch.kind === "plan") continue;
      outcomes.push(await closeLaunch(launch, deps));
    }
    return plannotatorToolCloseText(outcomes);
  }
  const launch = open.find((candidate) => candidate.id === session);
  if (!launch) return plannotatorUnknownSessionText(session);
  return plannotatorToolCloseText([await closeLaunch(launch, deps)]);
}

/**
 * Close one review: the server's host close (the reviewer's Close, draft
 * kept, the tab told). Only a server that answered as an older Plannotator
 * without the endpoint is stopped instead (SIGTERM to the plugin's own child,
 * which never deletes a draft). Plan reviews end only with a decision.
 */
async function closeLaunch(launch: TrackedLaunch, deps: PlannotatorToolDeps): Promise<PlannotatorCloseOutcome> {
  const { id, subject } = launch;
  if (launch.kind === "plan") return { id, subject, closed: false, reason: "plan" };
  if (!launch.port) {
    return { id, subject, closed: false, reason: "failed", detail: "its server has not started yet; try again in a moment" };
  }
  const answer = classifyHostCloseAnswer(
    await hostRequest(launch, HOST_CLOSE_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, deps),
  );
  switch (answer.kind) {
    case "closed":
      launch.closedByAgent = true;
      return { id, subject, closed: true, unsent: answer.unsent };
    case "decided":
      return { id, subject, closed: false, reason: "decided" };
    case "unreachable":
      // Nothing answers on its port: never signal on a guess.
      return { id, subject, closed: false, reason: "failed", detail: "its server is not answering" };
    case "refused":
      return { id, subject, closed: false, reason: "failed", detail: `its server refused the close (HTTP ${answer.status})` };
    case "disabled":
      // The server answered "host control off". Its ready file says whether
      // that is remote mode; otherwise it was started without a host token.
      return {
        id,
        subject,
        closed: false,
        reason: "failed",
        detail: launch.isRemote
          ? "it runs in remote mode, where Plannotator turns host close off; close it from the tab"
          : "its server has host close turned off (it was started without a host token); close it from the tab",
      };
    case "older": {
      // Proven an older Plannotator on the port of our own live child: stop
      // that child. A decision such a CLI is still publishing (it waits 1.5 s
      // after the reviewer decides) is lost; see "Version skew" in AGENTS.md.
      if (launch.terminate?.()) {
        launch.closedByAgent = true;
        return { id, subject, closed: true, unsent: null };
      }
      return { id, subject, closed: false, reason: "failed", detail: "its server process is gone" };
    }
  }
}
