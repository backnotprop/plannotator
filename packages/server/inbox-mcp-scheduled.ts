/**
 * The `routine` tool (docs/agent-guides/inbox-routines.md): an agent makes and keeps a routine
 * for the person. Served only while the person has routines on (the MCP context's `scheduledOn`): off, it
 * is not in tools/list, and a call from a session that listed it before answers `routines_off` with
 * nothing written. What an agent may do is in inbox-scheduled.ts: one it makes arrives off, and the person turns it
 * on the first time.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import type { InboxScheduledRow } from "@plannotator/core/inbox-scheduled-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { INBOX_SCHEDULED_OFF_TEXT, type InboxScheduled, type InboxScheduledBy } from "./inbox-scheduled";
import type { InboxRoutineGrants } from "./inbox-routine-grants";
import { guarded, okComplete, PROJECT_PATH_DESCRIPTION } from "./inbox-mcp-result";

export const SCHEDULED_THREAD_OPS = ["create", "list", "get", "update", "on", "off", "run", "delete"] as const;

export const SCHEDULED_THREAD_DESCRIPTION =
  "Routines in the Plannotator Inbox: a saved prompt an agent on this computer runs on a schedule, every run replying in the routine's own Inbox thread. Make one only when the person asks for work to run on its own, on a schedule. op: create, list, get, update, on, off, run, delete; update changes only the fields you pass. One you create arrives off, unless the person asked you for it with /create-routine in the thread you pass as thread_id: then it is on, and the result says so. Off, the person turns it on the first time, in the Inbox; after that you may update, turn it on or off, run and delete it. Changing its folder or its agent turns it off again until the person turns it back on. A schedule's runs are at least 15 minutes apart. Each change posts one line for the person: in thread_id, the thread you work in, if you pass it, else in the routine's own thread; runs reply only in their own thread.";

export interface InboxScheduledMcpContext {
  /** Whether the person has routines on, read on every request. Absent: off. */
  scheduledOn?: () => boolean;
  scheduled?: () => InboxScheduled | null;
  /** The person's `/create-routine` Sends (inbox-routine-grants.ts): a create naming that thread, from a session the Send went to, is made on. Absent: none. */
  routineGrants?: () => InboxRoutineGrants | null;
}

/**
 * Why a create arrived off, for the agent to act on (it is told the truth, then tells the person). `session` is the
 * caller's own word, as everywhere in the Inbox: a call that names none (a shell with no session of its own) is told
 * that, never that the request was for someone else, since the request may well be its; the grant stays held for its
 * retry through its Inbox tool, which names the session.
 */
const offBecause = (threadId: string | undefined, forAnother: boolean, session: string) =>
  !threadId
    ? " It is off until the person turns it on in Routines in the Inbox. A create starts on only with thread_id (--thread from a shell) naming the thread where the person asked for it with /create-routine."
    : forAnother && !session
      ? ` This call names no agent session, so it could not be matched to the person's /create-routine request in thread ${threadId}, and it is off until the person turns it on in Routines in the Inbox. To have it on, delete it and make it again with your Inbox tool's routine action, or from the shell with --session and your session id.`
      : forAnother
        ? ` The /create-routine request from the person in thread ${threadId} was for another agent session, not yours, so it is off until the person turns it on in Routines in the Inbox.`
        : ` No /create-routine request from the person in thread ${threadId} that this Inbox still holds (one lasts an hour and makes one routine, and an Inbox restart forgets it), so it is off until the person turns it on in Routines in the Inbox.`;

const rowLine = (row: InboxScheduledRow) =>
  `${row.id} "${row.name}": ${row.state}, ${row.schedule ? row.schedule_words : "runs only when run"}${row.tz_short ? ` (${row.tz_short})` : ""}, ${row.agent} in ${row.folder_shown}${row.next_run ? `, next ${row.next_run}` : ""}${row.approved_at ? "" : ", not yet turned on by the person"}${row.thread_id ? `, thread ${row.thread_id}` : ""}.`;

export function registerInboxScheduledTool(server: McpServer, context: InboxScheduledMcpContext): void {
  server.registerTool(
    "routine",
    {
      title: "Make or change a routine",
      description: SCHEDULED_THREAD_DESCRIPTION,
      inputSchema: z
        .object({
          op: z.enum(SCHEDULED_THREAD_OPS),
          id: z.string().optional().describe("The routine (sch_…); not for create or list."),
          name: z.string().optional().describe("A few words the person knows it by, e.g. \"Morning triage\"."),
          prompt: z.string().optional().describe("What each run is asked, in the person's words, whole."),
          schedule: z
            .object({ cron: z.string().optional(), at: z.string().optional(), tz: z.string().optional() })
            .strict()
            .nullable()
            .optional()
            .describe("{ cron: \"0 9 * * 1-5\", tz: \"America/New_York\" } (5-field cron), { at: \"<YYYY-MM-DDTHH:MM>\" } for once, or null: it runs only when run. tz optional: this computer's zone."),
          if_missed: z.enum(["run_once", "skip"]).optional().describe("A run missed while the computer slept: run it once when it wakes (default), or skip it."),
          folder: z
            .object({ path: z.string().optional(), scratch: z.literal(true).optional() })
            .strict()
            .optional()
            .describe("Where runs work: { path }, that folder itself (default: your project_path; never home, / or a hidden folder), or { scratch: true } for a new folder."),
          agent: z.string().optional().describe("claude-code, codex, opencode or pi. Default: your own host."),
          model: z.string().optional(),
          effort: z.string().optional(),
          attachments: z.array(z.string()).optional().describe("Full paths of files each run gets."),
          thread_id: z.string().optional().describe("The thread you are working in: your change lines go there, not the runs. Without it they go in the routine's own thread."),
          project_path: z.string().optional().describe(PROJECT_PATH_DESCRIPTION),
          agent_session: z.string().optional().describe("Your session id; the `plannotator inbox mcp` shim fills it."),
          agent_name: z.string().optional().describe("How the person sees you, e.g. \"Claude Code\"."),
          agent_host: z.string().optional().describe("Your agent host, e.g. claude-code, codex, cursor."),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input) =>
      guarded(async () => {
        const scheduled = context.scheduledOn?.() ? context.scheduled?.() : null;
        if (!scheduled) throw new InboxError("routines_off", INBOX_SCHEDULED_OFF_TEXT.replace(/^routines_off: /, ""));
        const by: InboxScheduledBy = {
          kind: "agent",
          host: input.agent_host?.trim() || "agent",
          session: input.agent_session?.trim() || "",
          name: input.agent_name?.trim() || input.agent_host?.trim() || "Agent",
          thread_id: input.thread_id?.trim() || null,
        };
        if (input.op === "list") {
          const rows = scheduled.list();
          return okComplete(rows.length === 0 ? "No routines." : rows.map(rowLine).join("\n"), { scheduled: rows });
        }
        const told = (id: string | null) => (id ? ` The person sees it in thread ${scheduled.threadOfLine(id)}.` : "");
        if (input.op === "create") {
          const path = input.folder?.path ?? input.project_path;
          if (!input.folder?.scratch && !path) throw new InboxError("validation_error", "folder: { path } or { scratch: true }, or pass project_path.", { field: "folder" });
          const folder = input.folder?.scratch ? { scratch: true } : { path };
          // The person's /create-routine Send in this thread, to this session, is their approval: taken now, and given
          // back only when the create is refused before anything is saved (once its fields pass, it stays used).
          const grants = context.routineGrants?.() ?? null;
          const taken = grants?.take(by.thread_id, by.session) ?? { grant: null, for_another: false };
          const grant = taken.grant;
          let checked = false;
          let made: Awaited<ReturnType<InboxScheduled["create"]>>;
          try {
            made = await scheduled.create({ ...input, folder, agent: input.agent ?? input.agent_host }, by, undefined, grant !== null, () => (checked = true));
          } catch (error) {
            if (grant && !checked) grants?.restore(grant);
            throw error;
          }
          const row = scheduled.rowOf(made.record);
          const said = grant ? ` It is on: the person asked for it with /create-routine in thread ${grant.thread_id}.` : offBecause(input.thread_id?.trim() || undefined, taken.for_another, by.session);
          return okComplete(`Made ${rowLine(row)}${said}${told(made.told)}`, { scheduled: row, asked_with_create_routine: grant !== null });
        }
        if (!input.id) throw new InboxError("validation_error", `id: required for ${input.op}.`, { field: "id" });
        switch (input.op) {
          case "get": {
            const { scheduled: row, runs } = scheduled.get(input.id);
            const words = { running: "running", replied: "replied", didnt_finish: "didn't finish", didnt_start: "didn't start" };
            const lines = runs.map((run) => `Run ${run.run}: ${run.started_at}, ${words[run.outcome]}${run.late ? ", late" : ""} (${run.message_id}).`);
            return okComplete([rowLine(row), `Prompt: ${JSON.stringify(row.prompt)}`, ...lines].join("\n"), { scheduled: row, runs });
          }
          case "update": {
            const folder = input.folder ? (input.folder.scratch ? { scratch: true } : { path: input.folder.path }) : undefined;
            const { record, told: line } = await scheduled.update(input.id, { ...input, folder }, by);
            const row = scheduled.rowOf(record);
            return okComplete(`${line ? "Changed" : "Nothing changed in"} ${rowLine(row)}${told(line)}`, { scheduled: row });
          }
          case "on":
          case "off": {
            const { record, told: line } = await scheduled.setOn(input.id, input.op === "on", by);
            return okComplete(`${rowLine(scheduled.rowOf(record))}${told(line)}`, { scheduled: scheduled.rowOf(record) });
          }
          case "run": {
            const { message, told: line } = await scheduled.runNow(input.id, by);
            const row = scheduled.get(input.id).scheduled;
            const run = message.scheduled_run!;
            const said = run.failed ? `Run ${run.run} did not start: ${run.failed} ${rowLine(row)}` : `Started run ${run.run} of ${rowLine(row)}`;
            return okComplete(`${said}${told(line)}`, { scheduled: row, message_id: message.id });
          }
          case "delete": {
            const { told: line } = await scheduled.remove(input.id, by);
            return okComplete(`Deleted ${input.id}. Its thread and past runs stay.${told(line)}`, { deleted: true });
          }
        }
      }),
  );
}
