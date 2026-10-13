import { join } from "node:path";
import * as z from "zod";
import {
  PLANNOTATOR_OUTCOME_REVIEW_POSTED,
  plannotatorDecisionHeading,
  plannotatorDecisionSubject,
  type PlannotatorTarget,
} from "@plannotator/shared/plannotator-tool";

/** The CLI's host result record (apps/hook/server/host-result.ts), the fields T3 reads. */
export const hostResultSchema = z.object({
  v: z.literal(1),
  surface: z.enum(["plan", "review", "annotate", "annotate-last"]).optional(),
  decision: z.enum(["approved", "annotated", "dismissed", "denied", "answered"]),
  message: z.string(), noop: z.boolean(), platform: z.boolean().optional(),
  annotationCount: z.number().optional(), target: z.union([z.string(), z.array(z.string())]).optional(),
  closedBy: z.literal("agent").optional(), unsentAnnotations: z.number().optional(),
});
export type T3HostResult = z.infer<typeof hostResultSchema>;

/**
 * Feedback longer than this goes to a file Claude reads, never truncated: the
 * Claude Code mod's limit (`INLINE_LIMIT_BYTES` in apps/hook/hooks/mod/delivery.ts),
 * well under T3's 120,000-character message cap.
 */
export const T3_INLINE_LIMIT_BYTES = 12 * 1024;
export const T3_FEEDBACK_FILE = "feedback.md";

export interface T3DecisionContext {
  kind: "annotate" | "review" | "last";
  subject: string;
  sessionId: string;
  /** The launch's own target (from the ready line); the record's wins. */
  target?: PlannotatorTarget;
  /** A gated annotate session: Claude was told to wait for the sign-off, so a bare approval is sent. */
  gate?: boolean;
  /** The review's own folder: where an oversized message is written. */
  directory: string;
  inlineLimitBytes?: number;
}

export type T3Decision =
  | { action: "send"; text: string; overflow?: { path: string; text: string } }
  | { action: "log"; text: string };

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The outcome a decision's heading names: the Claude Code mod's words (`outcomeOf`). */
function outcomeOf(record: T3HostResult, surface: string): string {
  const count = record.annotationCount;
  const comments = typeof count === "number" && count > 0 ? ` · ${plural(count, "comment", "comments")}` : "";
  if (record.decision === "approved") return record.noop ? "Approved" : `Approved with notes${comments}`;
  return surface === "review" ? `Changes requested${comments}` : `Feedback${comments}`;
}

/**
 * What a settled review sends to its T3 conversation, worded as the Claude
 * Code mod words it (`deliveryFor`): Close, Done with nothing to send and a
 * review LGTM send nothing (a gated annotate approval excepted); feedback is
 * headed `Plannotator: <subject> (pn-…) — <outcome>.` with its Target line;
 * a message over the inline limit is written to the review's feedback.md and
 * Claude is told to Read it. One difference from the mod: a review posted
 * straight to the PR platform is sent (`Review posted` and its status line,
 * as on Pi and OpenCode), since T3 has no log or suggestion line to show it in.
 */
export function t3Decision(record: T3HostResult, context: T3DecisionContext): T3Decision {
  const surface = record.surface ?? (context.kind === "last" ? "annotate-last" : context.kind);
  if (record.decision === "dismissed") {
    return { action: "log", text: record.closedBy === "agent" ? `${context.subject} was closed by the agent; nothing was sent.` : `${context.subject} was closed with no decision; nothing was sent.` };
  }
  const target = record.target ?? context.target;
  const subject = plannotatorDecisionSubject(context.subject, context.target, target);
  const body = record.message.trim();
  if (surface === "review" && record.platform === true) {
    const heading = plannotatorDecisionHeading(subject, context.sessionId, PLANNOTATOR_OUTCOME_REVIEW_POSTED, target);
    return { action: "send", text: body ? `${heading}\n\n${body}` : heading };
  }
  const approvalAwaited = context.gate === true && record.decision === "approved";
  if (record.noop && !approvalAwaited) {
    const what = record.decision === "approved" ? "approved with no notes" : "closed with no annotations";
    return { action: "log", text: `${subject} ${what}; nothing was sent.` };
  }
  const prefix = plannotatorDecisionHeading(subject, context.sessionId, outcomeOf(record, surface), target);
  if (byteLength(body) <= (context.inlineLimitBytes ?? T3_INLINE_LIMIT_BYTES)) {
    return { action: "send", text: body ? `${prefix}\n\n${body}` : prefix };
  }
  const path = join(context.directory, T3_FEEDBACK_FILE);
  const kb = Math.ceil(byteLength(body) / 1024);
  const counts = typeof record.annotationCount === "number" && record.annotationCount > 0
    ? `, ${plural(record.annotationCount, "annotation", "annotations")}`
    : "";
  return {
    action: "send",
    text: `${prefix}\n\nThe full feedback (${kb} KB${counts}) is too long to include here. Read all of it with the Read tool before you continue: ${path}`,
    overflow: { path, text: `${body}\n` },
  };
}
