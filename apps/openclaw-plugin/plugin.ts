import { INBOX_TOOL_NAME } from "../../packages/shared/inbox/connection";
import { OpenClawInbox, type OpenClawInboxDeps } from "./inbox";
import { watchRuns, type OpenClawPluginApi } from "./openclaw";

export function registerPlannotator(api: OpenClawPluginApi, deps: OpenClawInboxDeps = {}): OpenClawInbox {
  const inbox = new OpenClawInbox(api, deps);
  api.registerTool((ctx) => inbox.toolFor(ctx), { name: INBOX_TOOL_NAME });
  watchRuns(api, (sessionKey, runId, running) => inbox.onRun(sessionKey, runId, running));
  api.registerService({
    id: "plannotator-inbox",
    start: () => inbox.start(),
    stop: () => inbox.stop(),
  });
  return inbox;
}
