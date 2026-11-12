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

export interface TrackedLaunch {
  readonly id: string;
  readonly owner: string;
  readonly kind: LaunchKind;
  subject: string;
  baseSubject: string;
  target?: string | string[];
  readonly startedAt: number;
  url?: string;
  port?: number;
  isRemote?: boolean;
  token?: string;
  terminate?: () => boolean;
  closedByAgent: boolean;
}

export type LaunchStart =
  | { state: "ready"; url: string }
  | { state: "failed"; message: string }
  | { state: "ended" };

export interface LaunchHandle {
  readonly launch: TrackedLaunch;
  readonly observer: CliLaunch;
  readonly started: Promise<LaunchStart>;
  end(): void;
}

export class OpenCodeLaunchRegistry {
  private readonly launches = new Map<string, TrackedLaunch>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly randomHex: () => string = () => randomBytes(3).toString("hex"),
  ) {}

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

  private relabel(owner: string): void {
    const open = this.openFor(owner);
    const subjects = plannotatorDistinctSubjects(
      open.map((launch) => ({ subject: launch.baseSubject, ...(launch.target !== undefined ? { target: launch.target } : {}) })),
    );
    open.forEach((launch, index) => {
      launch.subject = subjects[index] ?? launch.subject;
    });
  }

  openFor(owner: string): TrackedLaunch[] {
    return [...this.launches.values()].filter((launch) => launch.owner === owner && !launch.closedByAgent);
  }
}

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

function reviewSubject(words: readonly string[]): string {
  for (const word of words) {
    const match = PR_URL.exec(word);
    if (match) return /merge_requests/i.test(word) ? `MR !${match[1]}` : `PR #${match[1]}`;
  }
  const directory = words[words.length - 1];
  return directory ? `changes in ${baseName(directory)}` : LOCAL_CHANGES_SUBJECT;
}

const LOCAL_CHANGES_SUBJECT = "local changes";

export function subjectFromServerTarget(kind: LaunchKind, typed: string, target: string | readonly string[]): string | null {
  if (kind === "plan" || kind === "last") return null;
  if (kind === "review" && typed === LOCAL_CHANGES_SUBJECT) return null;
  return plannotatorTargetSubject(kind, target);
}

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

export function commandSubject(command: string, rawArgs: string): { kind: LaunchKind; subject: string } | null {
  const words = rawArgs.trim().split(/\s+/).filter((word) => word && !word.startsWith("-"));
  switch (command) {
    case "plannotator-annotate": {
      const distinct = [...new Set(words)];
      if (distinct.length > 1 && distinct.every(looksLikeFilePath)) {
        return { kind: "annotate", subject: plannotatorBundleSubject(distinct) };
      }
      return { kind: "annotate", subject: annotateSubject(words) };
    }
    case "plannotator-review": {
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

export function toolSubject(call: PlannotatorToolInput): string {
  const targets = plannotatorToolTargets(call);
  switch (call.action) {
    case "annotate":
      return Array.isArray(call.target) ? plannotatorBundleSubject(targets) : annotateSubject(targets);
    case "review":
      return reviewSubject(targets);
    default:
      return LAST_SUBJECT;
  }
}

export function quoteReviewWord(word: string): string | null {
  if (!/[\s"']/.test(word)) return word;
  if (!word.includes('"')) return `"${word}"`;
  if (!word.includes("'")) return `'${word}'`;
  return null;
}

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
        ...(targets.length > 1 ? { annotateBundle: targets } : {}),
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

export const PLANNOTATOR_TOOL_SUBAGENT_LAST_TEXT =
  'Invalid plannotator call: action "last" annotates the main session\'s last message and is not available to a subagent.';

export function plannotatorLateFailureText(subject: string, sessionId: string, message: string): string {
  return [
    plannotatorDecisionHeading(subject, sessionId, "Did not open"),
    "",
    `Plannotator could not start: ${message}`,
    `Nothing more arrives for ${sessionId}; do not wait for it.`,
  ].join("\n");
}

export interface ToolSessionOwner {
  root: string;
  subagent: boolean;
}

export interface PlannotatorToolDeps {
  registry: OpenCodeLaunchRegistry;
  launch: (request: {
    sessionID: string;
    command: string;
    rawArgs: string;
    annotateArgs?: ParsedAnnotateArgs;
    annotateBundle?: readonly string[];
    launch: CliLaunch;
    notice: { sessionID: string; open: () => boolean };
  }) => Promise<void>;
  resolveOwner?: (sessionID: string) => Promise<ToolSessionOwner>;
  reportLateFailure?: (input: { sessionID: string; text: string }) => Promise<void> | void;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readyWaitMs?: { review: number; other: number };
  now?: () => number;
}

const READY_WAIT_MS = { review: 45_000, other: 15_000 };
const HOST_REQUEST_TIMEOUT_MS = 5_000;

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
  let answered = false;
  void deps
    .launch({
      sessionID: owner.root,
      command: request.command,
      rawArgs: request.rawArgs,
      ...(request.annotateArgs ? { annotateArgs: request.annotateArgs } : {}),
      ...(request.annotateBundle ? { annotateBundle: request.annotateBundle } : {}),
      launch: handle.observer,
      notice: { sessionID: context.sessionID, open: () => !answered },
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
  answered = true;

  if (start === "timeout") {
    void handle.started.then(async (late) => {
      if (late.state !== "failed") return;
      try {
        await deps.reportLateFailure?.({
          sessionID: owner.root,
          text: plannotatorLateFailureText(subject, handle.launch.id, late.message),
        });
      } catch {
      }
    });
    return plannotatorToolOpenedText(handle.launch.subject, undefined, gate, handle.launch.id, handle.launch.target);
  }
  switch (start.state) {
    case "ready":
      return plannotatorToolOpenedText(handle.launch.subject, start.url, gate, handle.launch.id, handle.launch.target);
    case "failed":
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
      return { id, subject, closed: false, reason: "failed", detail: "its server is not answering" };
    case "refused":
      return { id, subject, closed: false, reason: "failed", detail: `its server refused the close (HTTP ${answer.status})` };
    case "disabled":
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
      if (launch.terminate?.()) {
        launch.closedByAgent = true;
        return { id, subject, closed: true, unsent: null };
      }
      return { id, subject, closed: false, reason: "failed", detail: "its server process is gone" };
    }
  }
}
