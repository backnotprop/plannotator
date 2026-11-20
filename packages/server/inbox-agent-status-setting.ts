/**
 * The "Agent status" setting (owner, 2026-11-18: "it's probably an option that needs to be set ... in the settings
 * panel, but probably also the inbox triple dot drop downs"): off by default. On, every window draws each agent's
 * status mark (`InboxAgent.status_mark`, inbox-agent-mark.ts); off, only agents in a Rex pane carry one, as before.
 * The marks are worked out either way (the connections' `blocked` is only data); this decides the drawing.
 *
 * Kept in config.json `inboxAgentStatus`; written by `POST /api/inbox/settings` `{ agent_status: { on } }` and read by
 * `GET /api/inbox/settings` (`agent_status: { on }`). The windows learn it from the agents list (`status_marks` on
 * this Inbox's group), which every window reads again when it changes (it is part of the Agents signature), so the
 * Settings switch and the ⋮ menu's item stay in step in every window and on the phone.
 */
import type { PlannotatorConfig } from "@plannotator/shared/config";
import { InboxError } from "@plannotator/shared/inbox/schema";

export interface InboxAgentStatusSetting {
  on(): boolean;
  /** A save's `agent_status`: `{ on: boolean }` exactly, else a `validation_error`. `validateOnly`: checked, nothing written. */
  save(input: unknown, validateOnly?: boolean): { on: boolean };
}

export function createInboxAgentStatusSetting(deps: {
  loadConfig: () => Pick<PlannotatorConfig, "inboxAgentStatus">;
  saveConfig: (change: Pick<PlannotatorConfig, "inboxAgentStatus">) => void;
  /**
   * What config.json is now (its stat), so it is read and parsed again only when it changed: the 1 s delivery watch
   * and every list read ask (inbox-launch.ts keeps its config the same way). Absent: read every time.
   */
  configKey?: () => string;
}): InboxAgentStatusSetting {
  let cache: { key: string; on: boolean } | null = null;
  const on = () => {
    const key = deps.configKey?.();
    if (key !== undefined && cache?.key === key) return cache.on;
    const value = deps.loadConfig().inboxAgentStatus === true;
    if (key !== undefined) cache = { key, on: value };
    return value;
  };
  return {
    on,
    save(input, validateOnly = false) {
      if (!input || typeof input !== "object" || Array.isArray(input) || typeof (input as { on?: unknown }).on !== "boolean" || Object.keys(input).some((key) => key !== "on")) {
        throw new InboxError("validation_error", "agent_status: { on: boolean }.", { field: "agent_status" });
      }
      const next = (input as { on: boolean }).on;
      if (validateOnly) return { on: on() };
      deps.saveConfig({ inboxAgentStatus: next });
      if (on() !== next) throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.");
      return { on: on() };
    },
  };
}
