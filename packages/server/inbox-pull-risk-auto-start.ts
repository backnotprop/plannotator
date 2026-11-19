import { handoffStack, openLayers, pullHandoffMessage, pullHandoffThreadName, pullNounOf } from "@plannotator/core/inbox-pull-handoff";
import { type InboxLaunchAgent, type InboxPull, type InboxProject, type InboxPullRiskAutoMake, type InboxPullRiskAutoRun } from "@plannotator/core/inbox-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { InboxLaunch } from "./inbox-launch";
import type { PullRiskAutoJob } from "./inbox-pull-risk-auto";
import { threadAgent, type InboxPullLinkStore } from "./inbox-pulls";

export interface PullRiskAutoStartDeps {
  store: Pick<InboxStore, "startPersonThread">;
  launch: Pick<InboxLaunch, "enabled" | "prepare" | "abandon" | "begin" | "composeBlock">;
  resolveProject: (path: string) => Promise<InboxProject>;
  projectOf: (job: PullRiskAutoJob) => Promise<string | null>;
  own: (layers: InboxPull[], threadId: string, made: InboxPullRiskAutoMake) => void;
  skillsBlock: (names: readonly string[]) => string;
}

const SKILLS: Record<InboxPullRiskAutoMake, string[]> = { guide: ["review-curate"], show_me: ["show-me"] };
const LEVEL_WORD = { high: "High", medium: "Medium", low: "Low" } as const;

export function pullRiskAutoBody(job: Pick<PullRiskAutoJob, "stack" | "made" | "level">, skillsBlock: (names: readonly string[]) => string): { handed: PullRiskAutoJob["stack"]; name: string; body: string } {
  const handed = handoffStack(job.stack, {}) ?? job.stack;
  const noun = pullNounOf(handed);
  const what = openLayers(handed).length > 1 ? `this stack of ${noun}s` : `this ${noun}`;
  const why = `The Inbox sent this on its own, because ${what} ranked ${LEVEL_WORD[job.level]} risk.`;
  const words = pullHandoffMessage(handed, { kind: job.made }, { fenced: true });
  return { handed, name: pullHandoffThreadName(handed, null, job.stack), body: `${why}\n\n${words}\n\n${skillsBlock(SKILLS[job.made])}`.trimEnd() };
}

export function pullRiskAutoSettled(store: InboxPullLinkStore, run: Pick<InboxPullRiskAutoRun, "made" | "at" | "started_at"> & { thread_id: string }): boolean {
  if (threadAgent(store, run.thread_id)?.ended) return true;
  const since = run.started_at ?? run.at;
  const ids = store.threadMessageIds(run.thread_id);
  for (let i = ids.length - 1; i >= 0; i--) {
    const message = store.message(ids[i]!);
    if (!message) continue;
    if (message.created_at < since) break;
    if (message.author.kind === "agent" && (run.made === "guide" ? !!message.guide : !!message.show_me)) return true;
  }
  return false;
}

export function pullRiskAutoStart(deps: PullRiskAutoStartDeps): (job: PullRiskAutoJob) => Promise<{ thread_id: string }> {
  return async (job) => {
    if (!deps.launch.enabled()) throw new InboxError("launch_off", "Starting agents from the Inbox is off in Settings → Agents.");
    const projectId = await deps.projectOf(job);
    if (!projectId) throw new InboxError("project_not_found", "No project here is this pull request's repository.");
    const agent = (job.agent ?? (await deps.launch.composeBlock())?.agents[0]?.agent ?? null) as InboxLaunchAgent | null;
    if (!agent) throw new InboxError("agent_unavailable", "No agent can be started here.");
    const { handed, name, body } = pullRiskAutoBody(job, deps.skillsBlock);
    const prepared = await deps.launch.prepare({ agent, project_id: projectId }, { name, body, resolveProject: deps.resolveProject, background: true, keepLastChoice: true });
    if (prepared.launch.full_permissions) {
      deps.launch.abandon(prepared.launch, prepared.project);
      throw new InboxError("full_permissions", "Full permissions are on in Settings → Agents, so it is not started on its own.");
    }
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
      deps.own(openLayers(handed), result.message.thread_id, job.made);
    } catch {}
    return { thread_id: result.message.thread_id };
  };
}
