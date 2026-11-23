/**
 * Routines (docs/agent-guides/inbox-routines.md): the records, the clock and the runs. A run is a launch,
 * one per run inside the routine's one thread: its divider (`scheduled_run`) carries the prompt and that
 * run's own launch record, and the launcher keeps every other thread at one launch on its root.
 *
 * Nothing here runs, writes or sets a timer while the capability switch is off (`on()`).
 */
import type { InboxMessage, InboxProject, InboxRun } from "@plannotator/core/inbox-types";
import { inboxId, INBOX_HOST_NAMES } from "@plannotator/core/inbox-types";
import type {
  InboxScheduledChange,
  InboxScheduledFolder,
  InboxScheduledRow,
  InboxScheduledRun,
  InboxScheduledRunSummary,
  InboxScheduledSchedule,
  InboxScheduledThread,
} from "@plannotator/core/inbox-scheduled-types";
import {
  inboxScheduledDecide,
  inboxScheduledLateLine,
  inboxScheduledNext,
  inboxScheduledTimes,
  inboxScheduledTzShort,
  inboxScheduledWhen,
  inboxScheduleRefusal,
  inboxScheduleWords,
  SCHEDULED_LATE_MS,
  SCHEDULED_TICK_MS,
  routineLineText,
} from "@plannotator/core/inbox-scheduled";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { inboxLaunchedSession } from "@plannotator/core/inbox-run-line";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { InboxAttachment } from "@plannotator/core/inbox-types";
import type { InboxLaunch, InboxLaunchTarget } from "./inbox-launch";

export const INBOX_SCHEDULED_OFF_TEXT =
  "routines_off: Routines are off on this computer, so nothing was written. The person turns them on in Settings, Capabilities.";

/** Who asked: the person in the window, or an agent session (and the thread it asked from). */
export type InboxScheduledBy = { kind: "person" } | { kind: "agent"; host: string; session: string; name: string; thread_id: string | null };

/** The fields a create or an update takes, as the routes and the tool read them. */
export interface InboxScheduledInput {
  name?: unknown;
  prompt?: unknown;
  schedule?: unknown;
  if_missed?: unknown;
  folder?: unknown;
  agent?: unknown;
  model?: unknown;
  effort?: unknown;
  attachments?: unknown;
  enabled?: unknown;
}

const RUNNING: ReadonlySet<InboxRun["state"]> = new Set(["starting", "working", "waiting_answer", "waiting_terminal", "cloning"]);
const NAME_MAX = 80;

export function createInboxScheduled(deps: {
  store: InboxStore;
  launch: InboxLaunch;
  /** The capability switch, read on every call. */
  on: () => boolean;
  /** "Start agents from New message": a run is a launch. */
  launchOn: () => boolean;
  resolveProject: (path: string) => Promise<InboxProject>;
  recordAttachments: (paths: readonly string[], project: InboxProject, base: string) => Promise<InboxAttachment[]>;
  displayFolder: (path: string) => string;
  now?: () => number;
  log?: (line: string) => void;
}) {
  const { store, launch } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const iso = () => new Date(now()).toISOString();

  const found = (id: string): InboxScheduledThread => {
    const record = store.scheduledThread(id);
    if (!record) throw new InboxError("routine_not_found", `No routine ${id}.`);
    return record;
  };
  const save = (record: InboxScheduledThread, patch: Partial<InboxScheduledThread>): InboxScheduledThread => store.putScheduledThread({ ...record, ...patch, updated_at: iso() });
  /** Its thread, while it is there: one that is gone counts as none, and the next line starts a new one. */
  const threadOf = (record: InboxScheduledThread): string | null => (record.thread_id && store.message(record.thread_id) ? record.thread_id : null);

  // ── Runs, read from the thread ──

  const sameSchedule = (before: InboxScheduledThread, after: InboxScheduledThread) =>
    before.enabled === after.enabled &&
    before.approved_at === after.approved_at &&
    before.handled_through === after.handled_through &&
    JSON.stringify(before.schedule) === JSON.stringify(after.schedule);

  /** Every run's divider, oldest first (the detail's run list reads it; the clock and the list read only the newest). */
  const dividersOf = (record: InboxScheduledThread): InboxMessage[] =>
    record.thread_id
      ? store.threadMessageIds(record.thread_id).flatMap((id) => {
          const message = store.message(id);
          return message?.scheduled_run?.scheduled_id === record.id && message.scheduled_run.run !== undefined ? [message] : [];
        })
      : [];
  const lastDividerOf = (record: InboxScheduledThread): InboxMessage | null => store.scheduledLines(record.id).run;
  /** Where the clock counts from: the record's, or the newest due time it wrote a line for. */
  const handledThrough = (record: InboxScheduledThread): string | null => {
    const due = store.scheduledLines(record.id).due;
    return record.handled_through === null ? null : due && due > record.handled_through ? due : record.handled_through;
  };
  const summaryOf = (divider: InboxMessage): InboxScheduledRunSummary => {
    const run = divider.scheduled_run!;
    const line = divider.launch ? launch.runOfMessage(divider.id) : null;
    const session = inboxLaunchedSession(divider);
    // That run's own messages: the thread read back from its end to the divider.
    const ids = store.threadMessageIds(divider.thread_id);
    let replied = false;
    for (let i = ids.length - 1; !replied && session && i >= 0 && ids[i] !== divider.id; i--) {
      const m = store.message(ids[i]!);
      replied = m?.author.kind === "agent" && m.author.session === session && !m.turn_error && !m.scheduled_change;
    }
    const outcome = !divider.launch || divider.launch.error || run.failed ? "didnt_start" : line && RUNNING.has(line.state) ? "running" : replied ? "replied" : "didnt_finish";
    return { message_id: divider.id, run: run.run!, due_at: run.due_at, started_at: divider.created_at, late: run.late === true, outcome };
  };
  /**
   * A routine's Stop and Delete stop its run's session. A run in Rex (from before routines started only in the
   * background) is Rex's: the Inbox lets go of it, and the Stop or Delete still goes through.
   */
  const stopRunning = (messageId: string): Promise<void> =>
    launch.stopMessage(messageId).catch((error: unknown) => {
      if (!(error instanceof InboxError && error.code === "launch_in_rex")) throw error;
    });
  /** Run starts under way here (the clock's and Run now's alike): one at a time per routine. */
  const starting = new Set<string>();
  const runningOf = (record: InboxScheduledThread): InboxScheduledRunSummary | null => {
    const last = lastDividerOf(record);
    const summary = last ? summaryOf(last) : null;
    return summary?.outcome === "running" ? summary : null;
  };

  const folderShown = (record: InboxScheduledThread): { folder_shown: string; project_name: string | null } => {
    if ("scratch" in record.folder) return { folder_shown: "New scratch folder", project_name: null };
    if ("path" in record.folder) return { folder_shown: deps.displayFolder(record.folder.path), project_name: store.listProjects().find((p) => p.root === (record.folder as { path: string }).path)?.name ?? null };
    const project = store.project(record.folder.project_id);
    return project ? { folder_shown: deps.displayFolder(project.root), project_name: project.name } : { folder_shown: "A folder that is gone", project_name: null };
  };

  const lastChangeOf = (record: InboxScheduledThread): InboxScheduledRow["last_change"] => {
    const ids = record.thread_id ? store.threadMessageIds(record.thread_id) : [];
    for (let i = ids.length - 1; i >= 0; i--) {
      const m = store.message(ids[i]!);
      if (m?.scheduled_change?.scheduled_id !== record.id || m.author.kind !== "agent") continue;
      return { op: m.scheduled_change.op, by: m.author.name || INBOX_HOST_NAMES[m.author.host ?? ""] || "An agent", at: m.created_at };
    }
    return null;
  };

  const rowOf = ({ create_key: _key, ...record }: InboxScheduledThread): InboxScheduledRow => {
    const last = lastDividerOf(record);
    const lastRun = last ? summaryOf(last) : null;
    const running = lastRun?.outcome === "running";
    const at = new Date(now());
    const next = record.enabled && !record.done_at ? inboxScheduledNext(record.schedule, at) : null;
    return {
      ...record,
      state: record.done_at ? "done" : running ? "running" : record.enabled ? "on" : "off",
      schedule_words: inboxScheduleWords(record.schedule),
      tz_short: record.schedule ? inboxScheduledTzShort(record.schedule.tz, next ?? at) : null,
      next_run: next ? next.toISOString() : null,
      runs: last?.scheduled_run?.run ?? record.runs_before ?? 0,
      last_run: lastRun,
      running_since: running ? lastRun!.started_at : null,
      ...folderShown(record),
      thread_id: threadOf(record),
      thread_name: threadOf(record) ? (store.threadShortName(record.thread_id!) ?? store.message(record.thread_id!)?.subject ?? null) : null,
      last_change: lastChangeOf(record),
    };
  };

  // ── Checking what a person or an agent sends ──

  const text = (value: unknown, field: string, max: number): string => {
    if (typeof value !== "string" || value.trim() === "") throw new InboxError("validation_error", `${field}: required.`, { field });
    if (value.length > max) throw new InboxError("validation_error", `${field}: at most ${max} characters.`, { field });
    return field === "prompt" ? value.trim() : value.trim().replace(/\s+/g, " ");
  };
  /** `saved`: the schedule on record, which keeps its one-time time even once it has passed. */
  const scheduleOf = (value: unknown, saved?: InboxScheduledSchedule): InboxScheduledSchedule => {
    if (value === null || value === undefined) return null;
    const v = value as { cron?: unknown; at?: unknown; tz?: unknown };
    const tz = typeof v.tz === "string" && v.tz.trim() ? v.tz.trim() : Intl.DateTimeFormat().resolvedOptions().timeZone;
    const schedule = typeof v.cron === "string" && tz ? { cron: v.cron.trim(), tz } : typeof v.at === "string" && tz ? { at: v.at.trim(), tz } : undefined;
    if (!schedule || typeof value !== "object") throw new InboxError("validation_error", "schedule: { cron } or { at }, each with an optional tz, or null.", { field: "schedule" });
    const refused = inboxScheduleRefusal(schedule, JSON.stringify(schedule) === JSON.stringify(saved) ? undefined : new Date(now()));
    if (refused) throw new InboxError(refused.code, refused.error, { field: "schedule", ...(refused.every_minutes ? { every_minutes: refused.every_minutes } : {}) });
    return schedule;
  };
  const folderOf = async (value: unknown): Promise<InboxScheduledFolder> => {
    const v = value as { project_id?: unknown; scratch?: unknown; path?: unknown } | null;
    if (v && typeof v === "object" && v.scratch === true) return { scratch: true };
    if (v && typeof v === "object" && typeof v.project_id === "string") {
      if (!store.project(v.project_id)) throw new InboxError("folder_missing", `No project ${v.project_id}.`, { field: "folder" });
      return { project_id: v.project_id };
    }
    if (v && typeof v === "object" && typeof v.path === "string" && v.path.trim()) return { path: await launch.startFolder(v.path.trim()) };
    throw new InboxError("validation_error", "folder: { project_id }, { path } or { scratch: true }.", { field: "folder" });
  };
  const optionalToken = (value: unknown, field: string): string | undefined => {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string" || !/^[A-Za-z0-9._:/@[\]-]{1,128}$/.test(value) || value.startsWith("-")) throw new InboxError("validation_error", `${field}: a model or effort name.`, { field });
    return value;
  };
  const pathsOf = (value: unknown): string[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || !value.every((path) => typeof path === "string" && path.startsWith("/"))) {
      throw new InboxError("validation_error", "attachments: a list of full file paths.", { field: "attachments" });
    }
    return value;
  };

  /** The fields an input sets, checked; nothing is written when one is refused. */
  const fieldsOf = async (input: InboxScheduledInput, creating: boolean): Promise<Partial<InboxScheduledThread>> => {
    const out: Partial<InboxScheduledThread> = {};
    if (creating || input.name !== undefined) out.name = text(input.name, "name", NAME_MAX);
    if (creating || input.prompt !== undefined) out.prompt = text(input.prompt, "prompt", 100_000);
    if (input.if_missed !== undefined) {
      if (input.if_missed !== "run_once" && input.if_missed !== "skip") throw new InboxError("validation_error", "if_missed: run_once or skip.", { field: "if_missed" });
      out.if_missed = input.if_missed;
    }
    if (creating || input.folder !== undefined) out.folder = await folderOf(input.folder);
    if (creating || input.agent !== undefined) {
      if (typeof input.agent !== "string" || !launch.availableFor(input.agent)) throw new InboxError("validation_error", "agent: claude-code, codex, opencode or pi.", { field: "agent" });
      out.agent = input.agent;
    }
    if (input.model !== undefined) out.model = optionalToken(input.model, "model");
    if (input.effort !== undefined) out.effort = optionalToken(input.effort, "effort");
    if (input.attachments !== undefined) out.attachments = pathsOf(input.attachments);
    return out;
  };

  // ── What an agent's change says in its thread ──

  const linkOf = (record: InboxScheduledThread) => `[${routineLineText(record.name.replace(/[[\]]/g, ""))}](#routine=${record.id})`;
  const folderWords = (folder: InboxScheduledFolder) => {
    if ("scratch" in folder) return "a new scratch folder";
    const words = "path" in folder ? deps.displayFolder(folder.path) : store.project(folder.project_id) && deps.displayFolder(store.project(folder.project_id)!.root);
    return words ? routineLineText(words, "path") : "a folder that is gone";
  };
  const agentWords = (agent: string) => INBOX_HOST_NAMES[agent] ?? agent;
  const scheduleSentence = (schedule: InboxScheduledSchedule) => (schedule ? inboxScheduleWords(schedule).replace(/^Every /, "every ").replace(/^Once /, "once ").replace(/^On the /, "on the ") : "only when someone runs it");
  const fence = (lines: string[]) => {
    const body = lines.join("\n");
    const ticks = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    return `${ticks}diff\n${body}\n${ticks}`;
  };

  /**
   * Every change an agent makes says so, as that agent: in the thread it named, else in the routine's own thread (made
   * for the line when the routine has none yet, where its first run would go). The line is no one's words: it takes
   * no reply and wakes no run (the store's `threadOwner`, the window's `wordsMessage`).
   */
  const tell = async (by: InboxScheduledBy, record: InboxScheduledThread, body: string, change: Omit<InboxScheduledChange, "scheduled_id" | "name">): Promise<string | null> => {
    if (by.kind !== "agent") return null;
    const own = threadOf(record);
    const thread = (by.thread_id ? store.message(by.thread_id) : null) ?? (own ? store.message(own) : null);
    const line = { author: { kind: "agent" as const, host: by.host, session: by.session, name: by.name }, body, scheduled_change: { scheduled_id: record.id, name: record.name, ...change } };
    if (thread) return store.sendMessage({ ...line, project_id: thread.project_id, reply_to: store.threadMessageIds(thread.thread_id).at(-1) ?? thread.thread_id }).message.id;
    const project = projectOf(record) ?? (await firstProject(record));
    if (!project) return null;
    const sent = store.sendMessage({ ...line, project_id: project, subject: record.name }).message;
    const now = store.scheduledThread(record.id) ?? store.deletedScheduledThread(record.id);
    if (now && !threadOf(now)) save(now, { thread_id: sent.thread_id });
    return sent.id;
  };

  const changeLines = (before: InboxScheduledThread, after: InboxScheduledThread, fields: (keyof InboxScheduledThread)[], turnedOff: boolean): string => {
    const out: string[] = [];
    if (fields.includes("schedule")) out.push(`It now runs ${scheduleSentence(after.schedule)} (was ${scheduleSentence(before.schedule)}).`);
    if (fields.includes("folder")) out.push(`It now works in ${folderWords(after.folder)} (was ${folderWords(before.folder)}).`);
    if (fields.includes("agent")) out.push(`It now uses ${agentWords(after.agent)} (was ${agentWords(before.agent)}).`);
    if (fields.includes("name")) out.push(`Its name was ${routineLineText(before.name)}.`);
    const rest = fields.filter((f) => !["schedule", "folder", "agent", "name", "prompt"].includes(f));
    if (rest.length > 0) out.push(`Also changed: ${rest.join(", ").replace(/_/g, " ")}.`);
    if (fields.includes("prompt")) out.push(`The prompt:\n\n${fence([...before.prompt.split("\n").map((l) => `- ${l}`), ...after.prompt.split("\n").map((l) => `+ ${l}`)])}`);
    if (turnedOff) out.push("It is off until you turn it on again.");
    return out.join("\n\n");
  };

  // ── Starting a run ──

  const projectOf = (record: InboxScheduledThread): string | null => {
    const project = threadOf(record) ? store.message(record.thread_id!)?.project_id : "project_id" in record.folder ? record.folder.project_id : null;
    return project && store.project(project) ? project : null;
  };

  /**
   * Where a first run that didn't start files its line, so the person sees why, on the clock's run as on Run now: a
   * folder by its path that is there, in that folder's project; else the project of the thread an agent made it from;
   * else where a scratch thread goes, the scratch folders' own folder. A folder that isn't there never becomes a project.
   */
  const firstProject = async (record: InboxScheduledThread): Promise<string | null> => {
    const path = "path" in record.folder ? record.folder.path : null;
    const resolved = path && existsSync(path) ? await deps.resolveProject(path).catch(() => null) : null;
    if (resolved) return resolved.id;
    const madeIn = record.made_by?.thread_id ? store.message(record.made_by.thread_id)?.project_id : null;
    if (madeIn && store.project(madeIn)) return madeIn;
    const scratch = launch.settingsState().scratch_dir;
    return typeof scratch === "string" ? store.ensureProject({ name: basename(scratch) || scratch, root: scratch }).id : null;
  };

  /**
   * One run: its divider in the thread, then the launch. A run key answers the same divider again after a restart.
   * One start at a time per routine (`starting`); its number, thread and prompt are read after the launch is
   * ready. A run that didn't start is a divider that says why, or, with no thread or project to put it in, the error.
   */
  const startRun = async (id: string, due: { due_at: string; late: boolean; missed_before: number; by: InboxScheduledRun["by"] }): Promise<InboxMessage> => {
    if (starting.has(id)) throw new InboxError("routine_running", `${found(id).name} is running now.`);
    starting.add(id);
    try {
      const first = found(id);
      const currentForRun = (): InboxScheduledThread => {
        const record = found(id);
        if (due.by === "schedule" && (!deps.on() || !deps.launchOn() || !sameSchedule(first, record))) {
          throw new InboxError("routine_schedule_changed", "The routine's schedule or settings changed while it was starting.");
        }
        return record;
      };
      const bodyOf = (record: InboxScheduledThread) =>
        `${record.prompt}${due.late && record.schedule ? `\n\n${inboxScheduledLateLine(new Date(due.due_at), new Date(now()), record.schedule.tz)}` : ""}`;
      const runOf = (record: InboxScheduledThread): InboxScheduledRun => ({
        scheduled_id: record.id,
        name: record.name,
        run: (lastDividerOf(record)?.scheduled_run?.run ?? record.runs_before ?? 0) + 1,
        due_at: due.due_at,
        by: due.by,
        ...(due.late ? { late: true as const } : {}),
        ...(due.missed_before > 0 ? { missed_before: due.missed_before } : {}),
      });
      const key = `sch:${id}:${due.due_at}`;
      const where = first.folder;
      const target = ("project_id" in where ? { agent: first.agent, project_id: where.project_id } : "path" in where ? { agent: first.agent, folder: where.path } : { agent: first.agent, scratch: true }) as InboxLaunchTarget;
      if (first.model || first.effort) target.choice = { ...(first.model ? { model: first.model } : {}), ...(first.effort ? { effort: first.effort } : {}) };
      let prepared: Awaited<ReturnType<InboxLaunch["prepare"]>>;
      try {
        if (!deps.launchOn()) throw new InboxError("launch_off", "Starting agents from the Inbox is off. Turn it on in Settings → Agents.");
        // A routine's run starts in the background whatever "Start new agents in" says: never a new Rex tab per run.
        prepared = await launch.prepare(target, { name: first.name, body: bodyOf(first), resolveProject: deps.resolveProject, background: true });
      } catch (error) {
        const before = currentForRun();
        const project = projectOf(before) ?? (await firstProject(before));
        const record = currentForRun();
        const run = runOf(record);
        log(`Inbox scheduled ${id}: run ${run.run} did not start (${error instanceof InboxError ? error.code : "error"})`);
        if (!project) throw error;
        // New message's "Nothing was sent." is not a run's: the thread says "The run didn't start." before it.
        const why = (error instanceof Error ? error.message : String(error)).replace(/\s*Nothing was sent\.$/, "");
        const { message } = store.writeScheduledLine({ project_id: project, thread_id: threadOf(record), name: record.name, body: bodyOf(record), key, scheduled_run: { ...run, failed: why } });
        if (record.thread_id !== message.thread_id) save(record, { thread_id: message.thread_id });
        return message;
      }
      const live = (): InboxScheduledThread => {
        try {
          return currentForRun();
        } catch (error) {
          launch.abandon(prepared.launch, prepared.project);
          throw error;
        }
      };
      const record = live();
      let attachments: InboxAttachment[] = [];
      try {
        attachments = record.attachments.length > 0 ? await deps.recordAttachments(record.attachments, prepared.project, prepared.project.root) : [];
      } catch (error) {
        log(`Inbox scheduled ${id}: an attachment was left out (${error instanceof InboxError ? error.code : "error"})`);
      }
      const current = live();
      const previous = threadOf(current) ? (store.scheduledRunOf(current.thread_id!) ?? store.message(current.thread_id!)) : null;
      const { message, replayed } = store.writeScheduledLine({
        project_id: prepared.project.id,
        thread_id: threadOf(current),
        name: current.name,
        body: bodyOf(current),
        key,
        scheduled_run: runOf(current),
        to: prepared.to,
        launch: prepared.launch,
        attachments,
      });
      if (replayed) launch.abandon(prepared.launch, prepared.project);
      else launch.begin(message);
      // The previous run's session, idle, is let go of (a reply to it still says that run ended).
      if (previous?.launch && !replayed && launch.runOfMessage(previous.id) === null) void launch.stopMessage(previous.id).catch(() => {});
      if (current.thread_id !== message.thread_id || "scratch" in current.folder) {
        save(current, { thread_id: message.thread_id, ...("scratch" in current.folder ? { folder: { project_id: prepared.project.id } } : {}) });
      }
      return message;
    } finally {
      starting.delete(id);
    }
  };

  /** A skip line: a note in the thread, delivered to no session. A scratch one with no run yet has no thread: false. */
  const writeSkip = (record: InboxScheduledThread, skipped: NonNullable<InboxScheduledRun["skipped"]>): boolean => {
    const project = projectOf(record);
    if (!project || !record.schedule) return false;
    const tz = record.schedule.tz;
    const reason = { asleep: "this computer was asleep", not_running: "the Inbox wasn't running", still_running: "the last run was still going", missed: "the next run was less than 15 minutes away", late: "it couldn't start on time" }[skipped.reason];
    const when = skipped.count === 1 ? inboxScheduledWhen(new Date(skipped.to), tz) : `${inboxScheduledTimes(skipped.count)}, ${inboxScheduledWhen(new Date(skipped.from), tz)} to ${inboxScheduledWhen(new Date(skipped.to), tz)}`;
    const { message } = store.writeScheduledLine({
      project_id: project,
      thread_id: threadOf(record),
      name: record.name,
      body: `Skipped ${when} · ${reason}`,
      key: `sch:${record.id}:skip:${skipped.to}`,
      scheduled_run: { scheduled_id: record.id, name: record.name, due_at: skipped.to, by: "schedule", skipped },
    });
    if (record.thread_id !== message.thread_id) save(record, { thread_id: message.thread_id });
    return true;
  };

  // ── The clock ──

  let lastCheck: number | null = null;
  let checking = false;
  /** "Start agents" was off at a check: turning it on again starts from now, as the switch does (no catch-up). */
  let launchWasOff = false;
  /**
   * One check: for each routine that is on and approved, at most one run or one skip line. The record is
   * written only when no line says where the clock got to (a one-time one done, a run with nowhere to say it failed).
   */
  const check = async (): Promise<void> => {
    if (checking) return;
    const at = now();
    // Off (the capability, or launch): nothing runs, and what came due meanwhile is never caught up.
    if (!deps.on() || !deps.launchOn()) {
      lastCheck = null;
      launchWasOff ||= deps.on();
      return;
    }
    if (launchWasOff) {
      launchWasOff = false;
      fromNow();
    }
    const why = lastCheck === null ? ("not_running" as const) : at - lastCheck > SCHEDULED_LATE_MS ? ("asleep" as const) : null;
    lastCheck = at;
    checking = true;
    try {
      for (const { id } of store.scheduledThreads()) {
        if (!deps.on() || !deps.launchOn()) break;
        const record = store.scheduledThread(id);
        if (!record?.enabled || record.done_at || !record.approved_at || !record.schedule) continue;
        const running = starting.has(record.id) || runningOf(record) !== null;
        const decision = inboxScheduledDecide({ schedule: record.schedule, if_missed: record.if_missed, handled_through: handledThrough(record), now: new Date(at), why, running });
        if (decision.kind === "wait") continue;
        try {
          if (decision.kind === "run") await startRun(record.id, { ...decision, by: "schedule" });
          else writeSkip(record, decision);
        } catch (error) {
          // The code only: a message can name a folder.
          log(`Inbox scheduled ${record.id}: ${error instanceof InboxError ? error.code : error instanceof Error ? error.name : "error"}`);
        }
        const after = store.scheduledThread(record.id);
        if (!after || !deps.on() || !deps.launchOn() || !sameSchedule(record, after)) continue;
        const once = "at" in record.schedule;
        const behind = (handledThrough(after) ?? "") < decision.handled_through;
        if (once || behind) save(after, { ...(behind ? { handled_through: decision.handled_through } : {}), ...(once ? { done_at: iso(), enabled: false } : {}) });
      }
    } finally {
      checking = false;
    }
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  function fromNow(): void {
    lastCheck = null;
    const at = iso();
    for (const record of store.scheduledThreads()) if (record.enabled) save(record, { handled_through: at });
  }

  return {
    rowOf,
    /** The thread an agent's change line went to. */
    threadOfLine: (id: string): string => store.message(id)?.thread_id ?? id,
    list: (): InboxScheduledRow[] =>
      store
        .scheduledThreads()
        .map(rowOf)
        .sort((a, b) => {
          const rank = (row: InboxScheduledRow) => (row.state === "done" ? 2 : row.enabled || row.state === "running" ? 0 : 1);
          return rank(a) - rank(b) || (a.next_run ?? "~").localeCompare(b.next_run ?? "~") || a.created_at.localeCompare(b.created_at);
        }),
    /** The window's routine made with this create key, if it is still there. */
    withCreateKey: (key: string): InboxScheduledThread | null => store.scheduledThreads().find((record) => record.create_key === key) ?? null,
    get: (id: string) => {
      const record = found(id);
      return { scheduled: rowOf(record), runs: dividersOf(record).slice(-20).reverse().map(summaryOf) };
    },

    /**
     * `createKey`: the window's key, kept on the record (inbox-scheduled-once.ts). `asked`: an agent's create the
     * person asked for with `/create-routine` (a grant it took, inbox-routine-grants.ts): made approved and on, as
     * the person's own would be. Every field is checked the same either way. `checked`: called once every field passed,
     * just before the routine is saved: a throw after it may have left the routine written.
     */
    async create(input: InboxScheduledInput, by: InboxScheduledBy, createKey?: string, asked = false, checked?: () => void): Promise<{ record: InboxScheduledThread; told: string | null }> {
      const fields = await fieldsOf(input, true);
      const schedule = scheduleOf(input.schedule);
      checked?.();
      const on = (by.kind === "person" && input.enabled === true) || (by.kind === "agent" && asked);
      const at = iso();
      const record = store.putScheduledThread({
        id: inboxId("sch"),
        name: fields.name!,
        enabled: on,
        approved_at: on ? at : null,
        prompt: fields.prompt!,
        schedule,
        if_missed: fields.if_missed ?? "run_once",
        runs_on: "this_computer",
        folder: fields.folder!,
        agent: fields.agent!,
        ...(fields.model ? { model: fields.model } : {}),
        ...(fields.effort ? { effort: fields.effort } : {}),
        attachments: fields.attachments ?? [],
        thread_id: null,
        ...(createKey ? { create_key: createKey } : {}),
        ...(by.kind === "agent" ? { made_by: { host: by.host, session: by.session, thread_id: by.thread_id ?? "" } } : {}),
        handled_through: on ? at : null,
        created_at: at,
        updated_at: at,
      });
      const told = await tell(by, record, on ? `Made the routine ${linkOf(record)}. It is on, as you asked with /create-routine.` : `Made the routine ${linkOf(record)}. It is off until you turn it on.`, { op: "create" });
      return { record: found(record.id), told };
    },

    async update(id: string, input: InboxScheduledInput, by: InboxScheduledBy): Promise<{ record: InboxScheduledThread; told: string | null }> {
      found(id);
      const fields = await fieldsOf(input, false);
      // Folder validation can yield to a concurrent edit or delete. Apply only the fields
      // this caller sent to the record that still exists when validation finishes.
      const before = found(id);
      if (input.schedule !== undefined) fields.schedule = scheduleOf(input.schedule, before.schedule);
      const changed = (Object.keys(fields) as (keyof InboxScheduledThread)[]).filter((key) => JSON.stringify(fields[key] ?? null) !== JSON.stringify(before[key] ?? null));
      if (changed.length === 0) return { record: before, told: null };
      // An agent that changes where it works or which agent runs it hands the switch back to the person.
      const moved = by.kind === "agent" && (changed.includes("folder") || changed.includes("agent"));
      const patch: Partial<InboxScheduledThread> = { ...fields, ...(moved ? { enabled: false, approved_at: null } : {}) };
      // A new schedule counts from now: nothing it would have run before is caught up.
      if (changed.includes("schedule") && before.enabled) patch.handled_through = iso();
      if (changed.includes("schedule")) patch.done_at = undefined;
      const record = save(before, patch);
      const turnedOff = moved && (before.enabled || before.approved_at !== null);
      const told = await tell(by, record, `Changed the routine ${linkOf(record)}.\n\n${changeLines(before, record, changed, turnedOff)}`, {
        op: "update",
        fields: changed as InboxScheduledChange["fields"],
        ...(turnedOff ? { turned_off: true as const } : {}),
      });
      return { record, told };
    },

    async setOn(id: string, on: boolean, by: InboxScheduledBy): Promise<{ record: InboxScheduledThread; told: string | null }> {
      const before = found(id);
      if (on && by.kind === "agent" && !before.approved_at) {
        throw new InboxError("routine_not_approved", `The person turns ${before.name} on the first time, in the Inbox. Nothing was changed.`);
      }
      if (before.enabled === on) return { record: before, told: null };
      const at = iso();
      const record = save(before, on ? { enabled: true, handled_through: at, ...(by.kind === "person" ? { approved_at: at } : {}) } : { enabled: false });
      const told = await tell(by, record, `Turned the routine ${linkOf(record)} ${on ? "on" : "off"}.`, { op: on ? "on" : "off" });
      return { record, told };
    },

    /** Run now: the run's divider (its `scheduled_run.failed` says why when it didn't start). */
    async runNow(id: string, by: InboxScheduledBy): Promise<{ message: InboxMessage; told: string | null }> {
      const record = found(id);
      if (by.kind === "agent" && !record.approved_at) throw new InboxError("routine_not_approved", `The person turns ${record.name} on the first time, in the Inbox. Nothing was run.`);
      if (runningOf(record)) throw new InboxError("routine_running", `${record.name} is running now.`);
      if (!deps.launchOn()) throw new InboxError("launch_off", "Starting agents from the Inbox is off. Turn it on in Settings → Agents.");
      const message = await startRun(id, { due_at: iso(), late: false, missed_before: 0, by: by.kind });
      const n = message.scheduled_run!.run;
      const after = found(id);
      const told = message.scheduled_run!.failed
        ? await tell(by, after, `Run ${n} of the routine ${linkOf(after)} didn't start. Its thread says why.`, { op: "run" })
        : await tell(by, after, `Started run ${n} of the routine ${linkOf(after)}.`, { op: "run" });
      return { message, told };
    },

    async stopRun(id: string): Promise<InboxScheduledThread> {
      const record = found(id);
      const running = runningOf(record);
      if (running) await stopRunning(running.message_id);
      return record;
    },

    /** Delete: a run under way is stopped first. The record keeps its switch, so the window's Undo brings it back as it was. */
    async remove(id: string, by: InboxScheduledBy): Promise<{ told: string | null }> {
      const record = found(id);
      const running = runningOf(record);
      if (running) await stopRunning(running.message_id);
      save(found(id), { deleted_at: iso() });
      return { told: await tell(by, record, `Deleted the routine ${routineLineText(record.name)}. Its thread and past runs stay.`, { op: "delete" }) };
    },

    /** The window's Undo of a delete: back as it was, counting from now (nothing due meanwhile is caught up). */
    restore(id: string): InboxScheduledThread {
      const record = store.deletedScheduledThread(id) ?? found(id);
      return record.deleted_at ? save(record, { deleted_at: undefined, ...(record.enabled ? { handled_through: iso() } : {}) }) : record;
    },

    /** Turning the capability switch on: every routine that is on starts from now, with no catch-up. */
    switchedOn(): void {
      launchWasOff = false;
      fromNow();
    },

    /**
     * Before the person's reply is written: a reply to an earlier run of a routine (its divider or its
     * session's message) is refused, plainly. Only the newest run takes replies; an earlier one has ended and is never
     * started again. `picked`: a session the person chose for the reply, which goes there as it would anywhere.
     */
    checkReply(messageId: string, picked: unknown): void {
      const message = store.message(messageId);
      const root = message ? store.message(message.thread_id) : null;
      if (!message || !root?.scheduled_run || picked !== undefined) return;
      const session = message.author.kind === "agent" ? message.author.session : message.author.kind === "person" ? message.to?.session : null;
      const newest = store.scheduledRunOf(root.id) ?? (root.launch ? root : null);
      if (!session || !newest || newest.to?.session === session) return;
      const mine = store.threadMessageIds(root.id).find((id) => {
        const m = store.message(id);
        return m?.scheduled_run?.run !== undefined && m.launch && m.to?.session === session;
      });
      if (!mine) return;
      throw new InboxError(
        "routine_run_ended",
        `Run ${store.message(mine)!.scheduled_run!.run} has ended, so your reply was not sent. Reply to the latest run (Run ${newest.scheduled_run!.run}) instead.`,
      );
    },

    check,
    /** The clock follows the switch: one check now and one every 30 seconds while it is on, no timer while it is off. */
    sync(): void {
      if (deps.on() && !timer) {
        void check();
        timer = setInterval(() => void check(), SCHEDULED_TICK_MS);
        (timer as { unref?: () => void }).unref?.();
      } else if (!deps.on() && timer) {
        clearInterval(timer);
        timer = null;
        lastCheck = null;
      }
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export type InboxScheduled = ReturnType<typeof createInboxScheduled>;

/** The HTTP status of each refusal here (inbox.ts `ERROR_STATUS`). */
export const INBOX_SCHEDULED_ERROR_STATUS: Record<string, number> = {
  routine_not_found: 404,
  routines_off: 404,
  schedule_too_frequent: 422,
  schedule_invalid: 422,
  routine_running: 409,
  routine_not_approved: 409,
  routine_run_ended: 409,
};
