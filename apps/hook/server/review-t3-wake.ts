import { isT3ThreadId } from "../../../packages/core/inbox-t3";
import { createAgentEnvironment } from "../../../packages/server/inbox-agents";
import { createT3Local, type T3Local } from "../../../packages/server/inbox-t3-local";
import type { AgentWatch } from "./review-agent-watch";

const WAKE_MESSAGE = "A Plannotator code review is being submitted. Wait for the review feedback before taking action.";

/** Resume a T3 thread only for a mod review, and accept feedback only after its watcher returns. */
export function reviewT3Reviver(
  watch: AgentWatch | null,
  env: NodeJS.ProcessEnv = process.env,
  t3?: Pick<T3Local, "has" | "send">,
): (() => Promise<void>) | undefined {
  const thread = env.T3CODE_THREAD_ID;
  if (watch?.kind !== "mod" || env.CLAUDE_CODE_ENTRYPOINT !== "t3-code" || !isT3ThreadId(thread)) return undefined;
  const local = t3 ?? createT3Local({ environment: createAgentEnvironment() });
  return async () => {
    if (watch.presence() !== "gone" || !(await local.has(thread))) return;
    if (!("sent" in await local.send(thread, WAKE_MESSAGE))) return;
    const deadline = Date.now() + 20_000;
    while (watch.presence() === "gone" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
}
