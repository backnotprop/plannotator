import { handoffPushable, openLayers, pullHandoffMessage, pullHandoffThreadName, pullNounOf } from "@plannotator/core/inbox-pull-handoff";
import { initialLaunchChoice, type InboxLaunchChoice } from "@plannotator/core/inbox-launch-choice";
import { inboxLaunchNotReadyWords } from "@plannotator/core/inbox-launch-ready";
import { type InboxComposeLaunch, type InboxLaunchAgent, type InboxPull, type InboxProject, type InboxPullRiskAutoMake, type InboxPullRiskAutoRun } from "@plannotator/core/inbox-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { InboxLaunch } from "./inbox-launch";
import { pullRiskAutoHanded, type PullRiskAutoJob } from "./inbox-pull-risk-auto";
import { threadAgent, type InboxPullLinkStore } from "./inbox-pulls";

export interface PullRiskAutoStartDeps {
  store: Pick<InboxStore, "startPersonThread">;
  launch: Pick<InboxLaunch, "enabled" | "prepare" | "abandon" | "begin" | "composeBlock">;
  lastReviewAgent: () => string | null;
  resolveProject: (path: string) => Promise<InboxProject>;
  projectOf: (job: PullRiskAutoJob) => Promise<string | null>;
  own: (layers: InboxPull[], threadId: string, made: InboxPullRiskAutoMake) => void;
  skillsBlock: (names: readonly string[]) => string;
}

const SKILLS: Record<InboxPullRiskAutoMake, string[]> = { guide: ["review-curate"], picture_it: ["picture-it"] };
const AUTO_KEY = "pull-risk-auto:";
const LEVEL_WORD = { high: "High", medium: "Medium", low: "Low" } as const;
const STAY_PUT = "Don't switch branches, stash or touch uncommitted work here; read the diff with git from where you are.";
const STAY_PUT_OWN = "Until I ask you for changes, don't switch branches, stash or touch uncommitted work here; read the diff with git from where you are.";

export function pullRiskAutoBody(job: Pick<PullRiskAutoJob, "key" | "stack" | "made" | "level">, skillsBlock: (names: readonly string[]) => string): { handed: PullRiskAutoJob["stack"]; name: string; body: string } {
  const handed = pullRiskAutoHanded(job);
  const noun = pullNounOf(handed);
  const what = openLayers(handed).length > 1 ? `this stack of ${noun}s` : `this ${noun}`;
  const why = `The Inbox sent this on its own, because ${what} ranked ${LEVEL_WORD[job.level]} risk.`;
  const words = pullHandoffMessage(handed, { kind: job.made }, { fenced: true });
  return { handed, name: pullHandoffThreadName(handed, null, job.stack), body: `${why}\n\n${handoffPushable(handed) ? STAY_PUT_OWN : STAY_PUT}\n\n${words}\n\n${skillsBlock(SKILLS[job.made])}`.trimEnd() };
}

export function lastStartedReviewAgent(store: Pick<InboxStore, "message">, threadIds: Iterable<string>): string | null {
  let last: { agent: string; at: string } | null = null;
  for (const id of new Set(threadIds)) {
    const root = store.message(id);
    if (!root?.launch || !root.started_by_person || root.idempotency_key?.startsWith(AUTO_KEY)) continue;
    if (!last || root.launch.started_at > last.at) last = { agent: root.launch.agent, at: root.launch.started_at };
  }
  return last?.agent ?? null;
}

export type PullRiskAutoAgent = { agent: InboxLaunchAgent; name: string; choice?: InboxLaunchChoice } | { unavailable: string };

export async function pullRiskAutoAgent(deps: Pick<PullRiskAutoStartDeps, "launch" | "lastReviewAgent">, configured: string | null): Promise<PullRiskAutoAgent | null> {
  if (!deps.launch.enabled()) return null;
  const block = await deps.launch.composeBlock();
  const agents = block?.agents ?? [];
  const wanted = configured ?? deps.lastReviewAgent();
  const found = agents.find((one) => one.agent === wanted) ?? (configured ? undefined : agents[0]);
  if (!found) return configured ? { unavailable: configuredUnavailable(configured, block?.not_ready) } : null;
  const choice = initialLaunchChoice(found.choices);
  return { agent: found.agent, name: found.name, ...(Object.keys(choice).length > 0 ? { choice } : {}) };
}

function configuredUnavailable(configured: string, notReady: InboxComposeLaunch["not_ready"]): string {
  const why = notReady?.find((one) => one.agent === configured);
  if (!why) return `${configured} can't be started here.`;
  const words = inboxLaunchNotReadyWords({ agent: why.name, code: why.code, machine: null, overSsh: why.over_ssh === true });
  return `${words.line}.${words.fix ? ` ${words.fix}` : ""}`;
}

export function pullRiskAutoSettled(store: InboxPullLinkStore, run: Pick<InboxPullRiskAutoRun, "made" | "at" | "started_at"> & { thread_id: string }): boolean {
  if (!store.message(run.thread_id) || threadAgent(store, run.thread_id)?.ended) return true;
  const since = run.started_at ?? run.at;
  const ids = store.threadMessageIds(run.thread_id);
  for (let i = ids.length - 1; i >= 0; i--) {
    const message = store.message(ids[i]!);
    if (!message) continue;
    if (message.created_at < since) break;
    if (message.author.kind === "agent" && (run.made === "guide" ? !!message.guide : !!message.picture_it)) return true;
  }
  return false;
}

export function pullRiskAutoStart(deps: PullRiskAutoStartDeps): (job: PullRiskAutoJob) => Promise<{ thread_id: string }> {
  return async (job) => {
    if (!deps.launch.enabled()) throw new InboxError("launch_off", "Starting agents from the Inbox is off in Settings → Agents.");
    const projectId = await deps.projectOf(job);
    if (!projectId) throw new InboxError("project_not_found", "No project here is this pull request's repository.");
    const picked = await pullRiskAutoAgent(deps, job.agent);
    if (!picked) throw new InboxError("agent_unavailable", "No agent can be started here.");
    if ("unavailable" in picked) throw new InboxError("agent_unavailable", `${picked.unavailable} Nothing was sent.`);
    const { handed, name, body } = pullRiskAutoBody(job, deps.skillsBlock);
    const prepared = await deps.launch.prepare({ agent: picked.agent, project_id: projectId, ...(picked.choice ? { choice: picked.choice } : {}) }, { name, body, resolveProject: deps.resolveProject, background: true, keepLastChoice: true });
    let result: ReturnType<InboxStore["startPersonThread"]>;
    try {
      result = deps.store.startPersonThread({ project_id: prepared.project.id, body, to: prepared.to, idempotency_key: `${AUTO_KEY}${job.key}`, thread_name: name, thread_name_auto: true, thread_name_numbered: true, launch: prepared.launch });
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
