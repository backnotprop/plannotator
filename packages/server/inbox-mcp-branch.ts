/**
 * send_message's `branch` field (Branch reviews; rules in packages/core/inbox-branch-reports.ts, the store and git
 * reads in inbox-branch-reports.ts): an agent reports its branch ready for review. Listed only while the person has
 * Branch reviews on (config.json `inboxBranchReviews`, with Code review): off, the field is not in send_message's
 * schema, so a call with it is refused as an unknown key and agents get no words of it.
 *
 * One review thread per project and branch: a report with a new head goes into that thread as a reply; a report of a
 * head already reported sends nothing. It works from every way an agent reaches an Inbox (the tool, the stdio shim,
 * `plannotator inbox call`, the agent door of a paired cloud agent), since it is a field of the send they all make.
 */

import * as z from "zod";
import {
  checkInboxBranchField,
  inboxBranchReportStep,
  INBOX_BRANCH_FIELD_DESCRIPTION,
  INBOX_BRANCH_HEAD_NEEDED,
  INBOX_BRANCH_REVIEWS_OFF_TEXT,
  type InboxBranchField,
  type InboxBranchPlace,
  type InboxBranchReport,
} from "@plannotator/core/inbox-branch-reports";
import type { InboxProject } from "@plannotator/core/inbox-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";

/** The field as agents see it: one object, its parts named in the description. */
export const BRANCH_FIELD = z
  .object({
    name: z.string(),
    base: z.string().optional(),
    head: z.string().optional(),
    remote_url: z.string().optional(),
    summary: z.string().optional(),
  })
  .strict()
  .describe(INBOX_BRANCH_FIELD_DESCRIPTION);

/** What the Inbox server gives the tool for reports (packages/server/inbox.ts). */
export interface InboxBranchMcp {
  /** Whether Branch reviews is on (and Code review), read on every request. */
  on: () => boolean;
  /** The latest report of a project's branch, by canonical project id. */
  get: (projectId: string, branch: string) => InboxBranchReport | null;
  /** Git here for the report: its head, its base and whether the commit is in the project's checkout. */
  read: (project: InboxProject, field: InboxBranchField, workingFolder: string | undefined) => Promise<{ head: string | null; base: string | null; reachable: boolean; folder: string | null }>;
  /** A cloud agent named no project: the one project here whose origin is the remote it pushed to, if exactly one. */
  projectOfRemote?: (remoteUrl: string) => InboxProject | null;
  /** The report is in its thread: keep it and judge its risk once (when the person has that on). */
  recorded: (report: InboxBranchReport, reachable: boolean) => void;
  canonicalId: (projectId: string) => string;
}

export interface InboxBranchMcpContext {
  store: InboxStore;
  branches?: InboxBranchMcp;
  /** The call came through the agent door from a paired cloud agent (inbox-agent-door.ts). */
  cloudAgent?: { homeRoot: string };
}

/** The field checked before anything is sent: a refusal writes nothing. */
export function checkBranchSend(context: InboxBranchMcpContext, value: unknown): InboxBranchField {
  if (!context.branches?.on()) throw new InboxError("branch_reviews_off", INBOX_BRANCH_REVIEWS_OFF_TEXT.replace(/^branch_reviews_off: /, ""));
  const field = checkInboxBranchField(value);
  if (typeof field === "string") throw new InboxError("validation_error", field, { field: "branch" });
  return field;
}

export interface BranchSendPlan {
  project: InboxProject;
  field: InboxBranchField;
  step: "new" | "same" | "update";
  existing: InboxBranchReport | null;
  head: string | null;
  base: string | null;
  reachable: boolean;
  /** Where git read it. */
  folder: string | null;
  place: InboxBranchPlace;
  /** The report thread's latest message: the send goes there as a reply. */
  replyTo: string | null;
}

/**
 * Where the report goes, before the send: the project (a cloud agent's report of a pushed branch files under the
 * project whose origin it is, unless it named one), the branch's thread when it has one, and whether this head is new.
 */
export async function planBranchSend(context: InboxBranchMcpContext, project: InboxProject, field: InboxBranchField, workingFolder: string | undefined): Promise<BranchSendPlan> {
  const branches = context.branches!;
  const cloud = context.cloudAgent;
  let target = project;
  if (cloud && field.remote_url && project.root === cloud.homeRoot) target = branches.projectOfRemote?.(field.remote_url) ?? project;
  const read = await branches.read(target, field, cloud ? undefined : workingFolder);
  if (cloud && !read.head) throw new InboxError("validation_error", INBOX_BRANCH_HEAD_NEEDED, { field: "branch" });
  const projectId = branches.canonicalId(target.id);
  const found = branches.get(projectId, field.name);
  // A thread deleted since is no thread: the next report starts a new one.
  const thread = found ? context.store.thread(found.thread_id) : null;
  const existing = thread ? found : null;
  const replyTo = thread ? (thread.messages[thread.messages.length - 1]?.id ?? null) : null;
  return { project: target, field, step: inboxBranchReportStep(existing, read.head), existing, head: read.head, base: read.base, reachable: read.reachable, folder: read.folder, place: cloud ? "cloud" : "here", replyTo };
}

/** The record of a sent report. */
export function branchReportOf(plan: BranchSendPlan, sent: { thread_id: string; message_id: string; at: string }, agent: InboxBranchReport["agent"], canonicalId: string): InboxBranchReport {
  return {
    project_id: canonicalId,
    branch: plan.field.name,
    base: plan.base,
    head: plan.head,
    place: plan.place,
    remote_url: plan.field.remote_url ?? null,
    summary: plan.field.summary ?? null,
    thread_id: sent.thread_id,
    message_id: sent.message_id,
    at: sent.at,
    first_at: plan.existing?.first_at ?? sent.at,
    reports: (plan.existing?.reports ?? 0) + 1,
    agent,
    folder: plan.folder,
  };
}
