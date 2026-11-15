/**
 * Scheduled threads (docs/agent-guides/inbox-scheduled.md): the records, the clock and the runs. A run is a launch,
 * one per run inside the scheduled thread's one thread: its divider (`scheduled_run`) carries the prompt and that
 * run's own launch record, and the launcher keeps every other thread at one launch on its root.
 *
 * Nothing here runs, writes or sets a timer while the capability switch is off (`on()`).
 */
import type { InboxMessage, InboxProject, InboxRun } from "@plannotator/core/inbox-types";
import { inboxId } from "@plannotator/core/inbox-types";
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
  inboxScheduledTzShort,
  inboxScheduledWhen,
  inboxScheduleRefusal,
  inboxScheduleWords,
  SCHEDULED_LATE_MS,
  SCHEDULED_TICK_MS,
} from "@plannotator/core/inbox-scheduled";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { InboxAttachment } from "@plannotator/core/inbox-types";
import type { InboxLaunch, InboxLaunchTarget } from "./inbox-launch";

export const INBOX_SCHEDULED_OFF_TEXT =
  "scheduled_threads_off: Scheduled threads are off on this computer, so nothing was written. The person turns them on in Settings, Capabilities.";

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
    if (!record) throw new InboxError("scheduled_not_found", `No scheduled thread ${id}.`);
    return record;
  };
  const save = (record: InboxScheduledThread, patch: Partial<InboxScheduledThread>): InboxScheduledThread => store.putScheduledThread({ ...record, ...patch, updated_at: iso() });

  // ── Runs, read from the thread ──

  const dividersOf = (record: InboxScheduledThread): InboxMessage[] =>
    record.thread_id
      ? store.threadMessageIds(record.thread_id).flatMap((id) => {
          const message = store.message(id);
          return message?.scheduled_run?.scheduled_id === record.id && message.scheduled_run.run !== undefined ? [message] : [];
        })
      : [];
  const summaryOf = (divider: InboxMessage): InboxScheduledRunSummary => {
    const run = divider.scheduled_run!;
    const line = divider.launch ? launch.runOfMessage(divider.id) : null;
    const session = divider.launch?.session ?? null;
    const ids = store.threadMessageIds(divider.thread_id);
    const after = ids.slice(ids.indexOf(divider.id) + 1).map((id) => store.message(id));
    const replied = !!session && after.some((m) => m?.author.kind === "agent" && m.author.session === session && !m.turn_error);
    const outcome = !divider.launch || divider.launch.error || run.failed ? "didnt_start" : line && RUNNING.has(line.state) ? "running" : replied ? "replied" : "didnt_finish";
    return { message_id: divider.id, run: run.run!, due_at: run.due_at, started_at: divider.created_at, late: run.late === true, outcome };
  };
  const runningOf = (record: InboxScheduledThread): InboxScheduledRunSummary | null => {
    const last = dividersOf(record).at(-1);
    const summary = last ? summaryOf(last) : null;
    return summary?.outcome === "running" ? summary : null;
  };

  const folderShown = (record: InboxScheduledThread): { folder_shown: string; project_name: string | null } => {
    if ("scratch" in record.folder) return { folder_shown: "New scratch folder", project_name: null };
    const project = store.project(record.folder.project_id);
    return project ? { folder_shown: deps.displayFolder(project.root), project_name: project.name } : { folder_shown: "A folder that is gone", project_name: null };
  };

  const rowOf = (record: InboxScheduledThread): InboxScheduledRow => {
    const dividers = dividersOf(record);
    const last = dividers.at(-1);
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
      runs: dividers.length,
      last_run: lastRun,
      running_since: running ? lastRun!.started_at : null,
      ...folderShown(record),
    };
  };

  // ── Checking what a person or an agent sends ──

  const text = (value: unknown, field: string, max: number): string => {
    if (typeof value !== "string" || value.trim() === "") throw new InboxError("validation_error", `${field}: required.`, { field });
    if (value.length > max) throw new InboxError("validation_error", `${field}: at most ${max} characters.`, { field });
    return field === "prompt" ? value.trim() : value.trim().replace(/\s+/g, " ");
  };
  const scheduleOf = (value: unknown): InboxScheduledSchedule => {
    if (value === null || value === undefined) return null;
    const v = value as { cron?: unknown; at?: unknown; tz?: unknown };
    const tz = typeof v.tz === "string" && v.tz.trim() ? v.tz.trim() : null;
    const schedule = typeof v.cron === "string" && tz ? { cron: v.cron.trim(), tz } : typeof v.at === "string" && tz ? { at: v.at.trim(), tz } : undefined;
    if (!schedule || typeof value !== "object") throw new InboxError("validation_error", "schedule: { cron, tz }, { at, tz } or null.", { field: "schedule" });
    const refused = inboxScheduleRefusal(schedule);
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
    if (v && typeof v === "object" && typeof v.path === "string" && v.path.trim()) return { project_id: (await deps.resolveProject(v.path.trim())).id };
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
    if (creating || input.schedule !== undefined) out.schedule = scheduleOf(input.schedule);
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

  const linkOf = (record: InboxScheduledThread) => `[${record.name.replace(/[[\]]/g, "")}](#scheduled=${record.id})`;
  const folderWords = (folder: InboxScheduledFolder) => ("scratch" in folder ? "a new scratch folder" : (store.project(folder.project_id) && deps.displayFolder(store.project(folder.project_id)!.root)) || "a folder that is gone");
  const scheduleSentence = (schedule: InboxScheduledSchedule) => (schedule ? inboxScheduleWords(schedule).replace(/^Every /, "every ").replace(/^Once /, "once ").replace(/^On the /, "on the ") : "only when someone runs it");
  const fence = (lines: string[]) => {
    const body = lines.join("\n");
    const ticks = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    return `${ticks}diff\n${body}\n${ticks}`;
  };

  /** One message, as the calling agent, in the thread it asked from. A call with no thread posts nothing. */
  const tell = (by: InboxScheduledBy, record: InboxScheduledThread, body: string, change: Omit<InboxScheduledChange, "scheduled_id" | "name">): string | null => {
    if (by.kind !== "agent" || !by.thread_id) return null;
    const thread = store.message(by.thread_id);
    if (!thread) return null;
    const latest = store.threadMessageIds(thread.thread_id).at(-1) ?? thread.thread_id;
    const sent = store.sendMessage({
      project_id: thread.project_id,
      author: { kind: "agent", host: by.host, session: by.session, name: by.name },
      body,
      reply_to: latest,
      scheduled_change: { scheduled_id: record.id, name: record.name, ...change },
    });
    return sent.message.id;
  };

  const changeLines = (before: InboxScheduledThread, after: InboxScheduledThread, fields: (keyof InboxScheduledThread)[]): string => {
    const out: string[] = [];
    if (fields.includes("schedule")) out.push(`It now runs ${scheduleSentence(after.schedule)} (was ${scheduleSentence(before.schedule)}).`);
    if (fields.includes("folder")) out.push(`It now works in ${folderWords(after.folder)} (was ${folderWords(before.folder)}). It is off until you turn it on again.`);
    if (fields.includes("name")) out.push(`Its name was ${before.name}.`);
    const rest = fields.filter((f) => !["schedule", "folder", "name", "prompt"].includes(f));
    if (rest.length > 0) out.push(`Also changed: ${rest.join(", ").replace(/_/g, " ")}.`);
    if (fields.includes("prompt")) out.push(`The prompt:\n\n${fence([...before.prompt.split("\n").map((l) => `- ${l}`), ...after.prompt.split("\n").map((l) => `+ ${l}`)])}`);
    return out.join("\n\n");
  };

  // ── Starting a run ──

  /** One run: its divider in the thread, then the launch. A run key answers the same divider again after a restart. */
  const startRun = async (record: InboxScheduledThread, due: { due_at: string; late: boolean; missed_before: number; by: InboxScheduledRun["by"] }): Promise<InboxScheduledThread> => {
    const key = `sch:${record.id}:${due.due_at}`;
    const number = dividersOf(record).length + 1;
    const late = due.late && record.schedule ? `\n\n${inboxScheduledLateLine(new Date(due.due_at), new Date(now()), record.schedule.tz)}` : "";
    const body = `${record.prompt}${late}`;
    const run: InboxScheduledRun = {
      scheduled_id: record.id,
      name: record.name,
      run: number,
      due_at: due.due_at,
      by: due.by,
      ...(due.late ? { late: true as const } : {}),
      ...(due.missed_before > 0 ? { missed_before: due.missed_before } : {}),
    };
    const previous = dividersOf(record).at(-1);
    const target = ("project_id" in record.folder ? { agent: record.agent, project_id: record.folder.project_id } : { agent: record.agent, scratch: true }) as InboxLaunchTarget;
    if (record.model || record.effort) target.choice = { ...(record.model ? { model: record.model } : {}), ...(record.effort ? { effort: record.effort } : {}) };
    let prepared: Awaited<ReturnType<InboxLaunch["prepare"]>>;
    try {
      if (!deps.launchOn()) throw new InboxError("launch_off", "Starting agents from the Inbox is off. Turn it on in Settings → Agents.");
      prepared = await launch.prepare(target, { name: record.name, body, resolveProject: deps.resolveProject });
    } catch (error) {
      // Didn't start: the divider says why, where there is a thread or a project to put it in.
      const project = record.thread_id ? store.message(record.thread_id)?.project_id : "project_id" in record.folder ? record.folder.project_id : null;
      const why = error instanceof Error ? error.message : String(error);
      log(`Inbox scheduled ${record.id}: run ${number} did not start (${error instanceof InboxError ? error.code : "error"})`);
      if (!project || !store.project(project)) return record;
      const { message } = store.writeScheduledLine({ project_id: project, thread_id: record.thread_id, name: record.name, body, key, scheduled_run: { ...run, failed: why } });
      return save(store.scheduledThread(record.id) ?? record, { thread_id: message.thread_id });
    }
    let attachments: InboxAttachment[] = [];
    try {
      attachments = record.attachments.length > 0 ? await deps.recordAttachments(record.attachments, prepared.project, prepared.project.root) : [];
    } catch (error) {
      log(`Inbox scheduled ${record.id}: an attachment was left out (${error instanceof InboxError ? error.code : "error"})`);
    }
    const { message, replayed } = store.writeScheduledLine({
      project_id: prepared.project.id,
      thread_id: record.thread_id,
      name: record.name,
      body,
      key,
      scheduled_run: run,
      to: prepared.to,
      launch: prepared.launch,
      attachments,
    });
    if (replayed) launch.abandon(prepared.launch, prepared.project);
    else launch.begin(message);
    // The previous run's session, idle, is let go of (a reply to it still says that run ended).
    if (previous?.launch && !replayed && launch.runOfMessage(previous.id) === null) void launch.stopMessage(previous.id).catch(() => {});
    const current = store.scheduledThread(record.id) ?? record;
    return save(current, { thread_id: message.thread_id, ...("scratch" in current.folder ? { folder: { project_id: prepared.project.id } } : {}) });
  };

  const writeSkip = (record: InboxScheduledThread, skipped: NonNullable<InboxScheduledRun["skipped"]>): InboxScheduledThread => {
    const project = record.thread_id ? store.message(record.thread_id)?.project_id : "project_id" in record.folder ? record.folder.project_id : null;
    // A scratch one with no run yet has no thread to say it in: the skip is only counted.
    if (!project || !store.project(project) || !record.schedule) return record;
    const tz = record.schedule.tz;
    const reason = { asleep: "this computer was asleep", not_running: "the Inbox wasn't running", still_running: "the last run was still going", missed: "the next run was less than 15 minutes away" }[skipped.reason];
    const when = skipped.count === 1 ? inboxScheduledWhen(new Date(skipped.to), tz) : `${skipped.count} times, ${inboxScheduledWhen(new Date(skipped.from), tz)} to ${inboxScheduledWhen(new Date(skipped.to), tz)}`;
    const body = `Skipped ${when} · ${reason}`;
    const { message } = store.writeScheduledLine({
      project_id: project,
      thread_id: record.thread_id,
      name: record.name,
      body,
      key: `sch:${record.id}:skip:${skipped.to}`,
      scheduled_run: { scheduled_id: record.id, name: record.name, due_at: skipped.to, by: "schedule", skipped },
    });
    return save(record, { thread_id: message.thread_id });
  };

  // ── The clock ──

  let lastCheck: number | null = null;
  let checking = false;
  const check = async (): Promise<void> => {
    if (checking) return;
    const at = now();
    // Off (the capability, or launch): nothing runs. What came due meanwhile is handled as if the Inbox was not running.
    if (!deps.on() || !deps.launchOn()) {
      lastCheck = null;
      return;
    }
    const why = lastCheck === null ? ("not_running" as const) : at - lastCheck > SCHEDULED_LATE_MS ? ("asleep" as const) : null;
    lastCheck = at;
    checking = true;
    try {
      for (const record of store.scheduledThreads()) {
        if (!record.enabled || record.done_at || !record.approved_at || !record.schedule) continue;
        const decision = inboxScheduledDecide({ schedule: record.schedule, if_missed: record.if_missed, handled_through: record.handled_through, now: new Date(at), why, running: runningOf(record) !== null });
        if (decision.kind === "wait") continue;
        try {
          let after = decision.kind === "run" ? await startRun(record, { ...decision, by: "schedule" }) : writeSkip(record, decision);
          after = store.scheduledThread(record.id) ?? after;
          const once = "at" in record.schedule;
          save(after, { handled_through: decision.handled_through, ...(once ? { done_at: iso(), enabled: false } : {}) });
        } catch (error) {
          // The code only: a message can name a folder.
          log(`Inbox scheduled ${record.id}: ${error instanceof InboxError ? error.code : error instanceof Error ? error.name : "error"}`);
        }
      }
    } finally {
      checking = false;
    }
  };

  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    rowOf,
    list: (): InboxScheduledRow[] =>
      store
        .scheduledThreads()
        .map(rowOf)
        .sort((a, b) => {
          const rank = (row: InboxScheduledRow) => (row.state === "done" ? 2 : row.enabled || row.state === "running" ? 0 : 1);
          return rank(a) - rank(b) || (a.next_run ?? "~").localeCompare(b.next_run ?? "~") || a.created_at.localeCompare(b.created_at);
        }),
    get: (id: string) => {
      const record = found(id);
      return { scheduled: rowOf(record), runs: dividersOf(record).slice(-20).reverse().map(summaryOf) };
    },

    async create(input: InboxScheduledInput, by: InboxScheduledBy): Promise<{ record: InboxScheduledThread; told: string | null }> {
      const fields = await fieldsOf(input, true);
      const on = by.kind === "person" && input.enabled === true;
      const at = iso();
      const record = store.putScheduledThread({
        id: inboxId("sch"),
        name: fields.name!,
        enabled: on,
        approved_at: on ? at : null,
        prompt: fields.prompt!,
        schedule: fields.schedule ?? null,
        if_missed: fields.if_missed ?? "run_once",
        runs_on: "this_computer",
        folder: fields.folder!,
        agent: fields.agent!,
        ...(fields.model ? { model: fields.model } : {}),
        ...(fields.effort ? { effort: fields.effort } : {}),
        attachments: fields.attachments ?? [],
        thread_id: null,
        ...(by.kind === "agent" ? { made_by: { host: by.host, session: by.session, thread_id: by.thread_id ?? "" } } : {}),
        handled_through: on ? at : null,
        created_at: at,
        updated_at: at,
      });
      const told = tell(by, record, `Made the scheduled thread ${linkOf(record)}. It is off until you turn it on.`, { op: "create" });
      return { record, told };
    },

    async update(id: string, input: InboxScheduledInput, by: InboxScheduledBy): Promise<{ record: InboxScheduledThread; told: string | null }> {
      const before = found(id);
      const fields = await fieldsOf(input, false);
      const changed = (Object.keys(fields) as (keyof InboxScheduledThread)[]).filter((key) => JSON.stringify(fields[key] ?? null) !== JSON.stringify(before[key] ?? null));
      if (changed.length === 0) return { record: before, told: null };
      // An agent that moves the folder hands the switch back to the person.
      const moved = by.kind === "agent" && changed.includes("folder");
      const patch: Partial<InboxScheduledThread> = { ...fields, ...(moved ? { enabled: false, approved_at: null } : {}) };
      // A new schedule counts from now: nothing it would have run before is caught up.
      if (changed.includes("schedule") && before.enabled) patch.handled_through = iso();
      if (changed.includes("schedule")) patch.done_at = undefined;
      const record = save(before, patch);
      const told = tell(by, record, `Changed the scheduled thread ${linkOf(record)}.\n\n${changeLines(before, record, changed)}`, {
        op: "update",
        fields: changed as InboxScheduledChange["fields"],
        ...(moved ? { turned_off: true as const } : {}),
      });
      return { record, told };
    },

    setOn(id: string, on: boolean, by: InboxScheduledBy): { record: InboxScheduledThread; told: string | null } {
      const before = found(id);
      if (on && by.kind === "agent" && !before.approved_at) {
        throw new InboxError("scheduled_not_approved", `The person turns ${before.name} on the first time, in the Inbox. Nothing was changed.`);
      }
      if (before.enabled === on) return { record: before, told: null };
      const at = iso();
      const record = save(before, on ? { enabled: true, handled_through: at, ...(by.kind === "person" ? { approved_at: at } : {}) } : { enabled: false });
      const told = tell(by, record, `Turned the scheduled thread ${linkOf(record)} ${on ? "on" : "off"}.`, { op: on ? "on" : "off" });
      return { record, told };
    },

    async runNow(id: string, by: InboxScheduledBy): Promise<InboxScheduledThread> {
      const record = found(id);
      if (by.kind === "agent" && !record.approved_at) throw new InboxError("scheduled_not_approved", `The person turns ${record.name} on the first time, in the Inbox. Nothing was run.`);
      if (runningOf(record)) throw new InboxError("scheduled_running", `${record.name} is running now.`);
      if (!deps.launchOn()) throw new InboxError("launch_off", "Starting agents from the Inbox is off. Turn it on in Settings → Agents.");
      return startRun(record, { due_at: iso(), late: false, missed_before: 0, by: by.kind });
    },

    async stopRun(id: string): Promise<InboxScheduledThread> {
      const record = found(id);
      const running = runningOf(record);
      if (running) await launch.stopMessage(running.message_id);
      return record;
    },

    remove(id: string, by: InboxScheduledBy): { told: string | null } {
      const record = found(id);
      save(record, { deleted_at: iso(), enabled: false });
      return { told: tell(by, record, `Deleted the scheduled thread ${record.name}. Its thread and past runs stay.`, { op: "delete" }) };
    },

    /** Turning the capability switch on: every scheduled thread that is on starts from now, with no catch-up. */
    switchedOn(): void {
      lastCheck = null;
      const at = iso();
      for (const record of store.scheduledThreads()) if (record.enabled) save(record, { handled_through: at });
    },

    /**
     * Before the person's reply is written: a reply to an earlier run of a scheduled thread (its divider or its
     * session's message) is refused, plainly. Only the newest run takes replies; an earlier one has ended and is never
     * started again. `picked`: a session the person chose for the reply, which goes there as it would anywhere.
     */
    checkReply(messageId: string, picked: unknown): void {
      const message = store.message(messageId);
      if (!message || picked !== undefined) return;
      const session = message.author.kind === "agent" ? message.author.session : message.author.kind === "person" ? message.to?.session : null;
      if (!session) return;
      const runs = store.threadMessageIds(message.thread_id).flatMap((id) => {
        const m = store.message(id);
        return m?.scheduled_run?.run !== undefined && m.launch ? [m] : [];
      });
      const mine = runs.find((m) => m.to?.session === session);
      if (!mine || mine === runs.at(-1)) return;
      throw new InboxError(
        "scheduled_run_ended",
        `Run ${mine.scheduled_run!.run} has ended, so your reply was not sent. Reply to the latest run (Run ${runs.at(-1)!.scheduled_run!.run}) instead.`,
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
  scheduled_not_found: 404,
  scheduled_threads_off: 404,
  schedule_too_frequent: 422,
  schedule_invalid: 422,
  scheduled_running: 409,
  scheduled_not_approved: 409,
  scheduled_run_ended: 409,
};
