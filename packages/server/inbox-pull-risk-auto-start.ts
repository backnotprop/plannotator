import { inboxBuiltinSkillsBlock } from "@plannotator/core/inbox-builtin-skills-block";
import { openLayers, pullHandoffMessage, pullHandoffThreadName } from "@plannotator/core/inbox-pull-handoff";
import { type InboxLaunchAgent, type InboxPull, type InboxProject, type InboxPullRiskAutoMake } from "@plannotator/core/inbox-types";
import { INBOX_MESSAGE_SKILL_AUDIENCE } from "@plannotator/core/skill-reference-block";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { InboxLaunch } from "./inbox-launch";
import type { PullRiskAutoJob } from "./inbox-pull-risk-auto";

export interface PullRiskAutoStartDeps {
  store: Pick<InboxStore, "startPersonThread">;
  launch: Pick<InboxLaunch, "enabled" | "prepare" | "abandon" | "begin" | "composeBlock">;
  resolveProject: (path: string) => Promise<InboxProject>;
  projectOf: (job: PullRiskAutoJob) => Promise<string | null>;
  own: (layers: InboxPull[], threadId: string, made: InboxPullRiskAutoMake) => void;
}

const SKILLS: Record<InboxPullRiskAutoMake, string[]> = { guide: ["review-curate"], show_me: ["show-me"], both: ["review-curate", "show-me"] };

export function pullRiskAutoBody(job: Pick<PullRiskAutoJob, "stack" | "made">): { name: string; body: string } {
  const words = pullHandoffMessage(job.stack, { kind: job.made });
  return { name: pullHandoffThreadName(job.stack, null), body: `${words}\n\n${inboxBuiltinSkillsBlock(SKILLS[job.made], INBOX_MESSAGE_SKILL_AUDIENCE)}` };
}

export function pullRiskAutoStart(deps: PullRiskAutoStartDeps): (job: PullRiskAutoJob) => Promise<{ thread_id: string }> {
  return async (job) => {
    if (!deps.launch.enabled()) throw new InboxError("launch_off", "Starting agents from the Inbox is off. Turn it on in Settings → Agents.");
    const projectId = await deps.projectOf(job);
    if (!projectId) throw new InboxError("project_not_found", "No project here is this pull request's repository.");
    const agent = (job.agent ?? (await deps.launch.composeBlock())?.agents[0]?.agent ?? null) as InboxLaunchAgent | null;
    if (!agent) throw new InboxError("agent_unavailable", "No agent can be started here.");
    const { name, body } = pullRiskAutoBody(job);
    const prepared = await deps.launch.prepare({ agent, project_id: projectId }, { name, body, resolveProject: deps.resolveProject, background: true });
    let result: ReturnType<InboxStore["startPersonThread"]>;
    try {
      result = deps.store.startPersonThread({ project_id: prepared.project.id, body, to: prepared.to, idempotency_key: `pull-risk-auto:${job.key}`, thread_name: name, thread_name_auto: true, thread_name_numbered: true, launch: prepared.launch });
    } catch (error) {
      deps.launch.abandon(prepared.launch, prepared.project);
      throw error;
    }
    if (result.replayed) deps.launch.abandon(prepared.launch, prepared.project);
    else deps.launch.begin(result.message);
    try {
      deps.own(openLayers(job.stack), result.message.thread_id, job.made);
    } catch {}
    return { thread_id: result.message.thread_id };
  };
}
