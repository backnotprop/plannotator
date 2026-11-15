import { personalAgentConnected } from "@plannotator/core/inbox-personal-agents";
import { configuredInboxTool, type PlannotatorConfig } from "@plannotator/shared/config";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { readCloudAgents } from "./inbox-cloud-agents";

/** A personal agent is connected on this computer (core/inbox-personal-agents.ts), read from disk on every call. */
export function personalAgentConnectedHere(input: { dataDir: string; config: PlannotatorConfig; store: Pick<InboxStore, "threadIds" | "message"> }): boolean {
  const { dataDir, config, store } = input;
  return personalAgentConnected({
    cloudPresets: readCloudAgents(dataDir).map((agent) => agent.preset),
    toolOn: (host) => configuredInboxTool(config, host) === true,
    threadAuthorHosts: function* () {
      for (const threadId of store.threadIds()) {
        const author = store.message(threadId)?.author;
        if (author?.kind === "agent") yield author.host;
      }
    },
  });
}
