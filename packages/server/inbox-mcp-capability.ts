/**
 * The `capability` tool (docs/agent-guides/inbox-machines.md, "Capabilities on a linked computer"): an agent turns one
 * of Settings → Capabilities' switches on or off when the person asks it to (the owner, 2026-11-24: "Yes, an agent I
 * ask can turn any capability on or off"), on this computer or on a linked one. Only the switches a person sees there
 * (core `INBOX_CAPABILITY_AGENT_SWITCHES`: a hidden one, as System is, is not offered). Always listed, whatever is on:
 * it is how a switch that is off gets turned on. A turn posts one line for the person, as the agent: in the thread it
 * names, else in a new thread in its project, with no sound.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { INBOX_CAPABILITY_AGENT_IDS, INBOX_CAPABILITY_AGENT_SWITCHES, INBOX_CAPABILITY_SWITCHES, type InboxCapabilitySwitches, type InboxCapabilitySwitchKey } from "@plannotator/core/inbox-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { guarded, okComplete, PROJECT_PATH_DESCRIPTION } from "./inbox-mcp-result";
import { NO_CHANGE_LINE } from "./inbox-mcp-scheduled";

export const CAPABILITY_TOOL_DESCRIPTION =
  "The Plannotator Inbox's capabilities, the switches in Settings, Capabilities. Turn one on or off when the person asks you to; not on your own initiative. Without `on`, it lists each one and whether it is on. `computer`: a linked computer's name, to read or turn one there. A turn posts one line for the person: in thread_id, the thread you work in, if you pass it, else in a new thread in your project.";

export interface InboxCapabilityTurnBy {
  host: string;
  session: string;
  name: string;
}

/** A linked computer's switches as the forward gave them (inbox-machines.ts `capabilitiesOn`). */
export interface InboxCapabilityThere {
  name: string;
  switches: InboxCapabilitySwitches | null;
  held: string | null;
  /** Away: when it last gave its switches. */
  awaySince?: string | null;
  /** The switches turned for it that wait for it. */
  pending?: string[];
  /** A held turn's end: taken, or not with its words. */
  settled?: Promise<{ taken: boolean; why: string | null }>;
}

export interface InboxCapabilityMcpContext {
  /** The project an agent's path names (the agent door's own lookup for a paired agent). */
  resolveProject?: (path: string) => Promise<{ id: string }>;
  capabilities?: {
    /** This computer's switches, each one it offers now. */
    here: () => InboxCapabilitySwitches;
    /** Turns one here, as Settings does; answers the switches after. */
    set: (key: InboxCapabilitySwitchKey, on: boolean) => Promise<InboxCapabilitySwitches>;
    /** A linked computer's (`change` null: read). Null: no linked computer has that name. */
    there: (computer: string, change: { key: InboxCapabilitySwitchKey; on: boolean } | null) => Promise<InboxCapabilityThere | null>;
    /** The linked computers' names, for a name that matches none. */
    linked: () => string[];
    /**
     * The one line for the person: in that thread, else a new thread in the agent's project (`project`, asked only
     * then: a lookup may make it). The thread id, or null when it had nowhere to go.
     */
    tell: (by: InboxCapabilityTurnBy, threadId: string | null, project: () => Promise<string | null>, body: string) => Promise<string | null>;
  };
}

const switchOf = (id: string) => INBOX_CAPABILITY_SWITCHES.find((s) => s.agent === id)!;

/** Only the switches an agent may see: a hidden one never shows in a list or a structured answer. */
const shown = (switches: InboxCapabilitySwitches): InboxCapabilitySwitches =>
  Object.fromEntries(INBOX_CAPABILITY_AGENT_SWITCHES.flatMap((s) => (switches[s.key] ? [[s.key, switches[s.key]]] : [])));

const listLine = (where: string, switches: InboxCapabilitySwitches) => {
  const parts = INBOX_CAPABILITY_AGENT_SWITCHES.flatMap((s) => (switches[s.key] ? [`${s.agent} ${switches[s.key]!.on ? "on" : "off"}`] : []));
  return parts.length === 0 ? `${where}: none offered.` : `${where}: ${parts.join(", ")}.`;
};

/** The action a switch serves in this Inbox's own tools, and its shell form, which works as soon as the switch is on. */
const SERVES: Partial<Record<InboxCapabilitySwitchKey, { action: string; shell: string }>> = {
  board: { action: "card", shell: "plannotator card --help" },
  steps: { action: "steps", shell: "plannotator inbox steps <thread> --json '<list>'" },
  scheduled_threads: { action: "routine", shell: "plannotator routine --help" },
};

/** A switch on here that serves an action: a session listed before has no such action yet (tool lists are made at start). */
function servesLine(key: InboxCapabilitySwitchKey): string {
  const serves = SERVES[key];
  return serves ? ` Agents get the ${serves.action} action in their next session (a session's tools are listed once, at its start); from a shell it works now: \`${serves.shell}\`.` : "";
}

/** The line the person sees, as the agent: "Turned on Routines." / "Turned off Board on Studio." */
export function capabilityLineText(name: string, on: boolean, computer: string | null, held: boolean): string {
  return `Turned ${on ? "on" : "off"} ${name}${computer ? ` on ${computer}` : ""}.${held && computer ? ` It applies when ${computer} is back.` : ""}`;
}

/** The line after a held turn that computer did not take. */
export function capabilityNotTakenText(name: string, on: boolean, computer: string, why: string | null): string {
  return `${computer} did not turn ${on ? "on" : "off"} ${name}${why ? `: ${why.replace(/\.$/, "")}` : ""}.`;
}

export function registerInboxCapabilityTool(server: McpServer, context: InboxCapabilityMcpContext): void {
  server.registerTool(
    "capability",
    {
      title: "Turn a capability on or off",
      description: CAPABILITY_TOOL_DESCRIPTION,
      inputSchema: z
        .object({
          capability: z.enum(INBOX_CAPABILITY_AGENT_IDS).optional().describe("Which one. Required with `on`."),
          on: z.boolean().optional().describe("true turns it on, false turns it off. Leave it out to list them."),
          computer: z.string().optional().describe("A linked computer's name, as the Inbox shows it. Default: this computer."),
          thread_id: z.string().optional().describe("The thread you are working in: the line for the person goes there."),
          project_path: z.string().optional().describe(PROJECT_PATH_DESCRIPTION),
          agent_session: z.string().optional().describe("Your session id; the `plannotator inbox mcp` shim fills it."),
          agent_name: z.string().optional().describe("How the person sees you, e.g. \"Claude Code\"."),
          agent_host: z.string().optional().describe("Your agent host, e.g. claude-code, codex, cursor."),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      guarded(async () => {
        const caps = context.capabilities;
        if (!caps) throw new InboxError("not_available", "This Inbox cannot turn its capabilities from here.");
        const computer = input.computer?.trim() || null;
        const nowhere = (asked: string) => {
          const names = caps.linked();
          return new InboxError("machine_not_found", `No linked computer is named ${asked}. ${names.length > 0 ? `Linked: ${names.join(", ")}.` : "No computer is linked."} Leave computer out for this computer.`);
        };
        /** A linked computer's read: as it last said while it is away, and what waits for it. */
        const awayLine = (read: InboxCapabilityThere) => {
          const waiting = (read.pending ?? []).flatMap((key) => INBOX_CAPABILITY_AGENT_SWITCHES.filter((s) => s.key === key).map((s) => s.agent));
          if (!read.awaySince) return waiting.length > 0 ? ` Waiting for ${read.name}: ${waiting.join(", ")}.` : "";
          return ` ${read.name} is away: these are as it last said, at ${read.awaySince}.${waiting.length > 0 ? ` Turned here and waiting for it: ${waiting.join(", ")}.` : ""}`;
        };
        if (input.on === undefined) {
          if (input.capability) throw new InboxError("validation_error", "on: true or false, to turn it; leave capability out to list them.", { field: "on" });
          if (!computer) return okComplete(listLine("On this computer", caps.here()), { capabilities: shown(caps.here()) });
          const read = await caps.there(computer, null);
          if (!read) throw nowhere(computer);
          return okComplete(`${listLine(`On ${read.name}`, read.switches ?? {})}${awayLine(read)}`, {
            computer: read.name,
            capabilities: shown(read.switches ?? {}),
            ...(read.awaySince ? { away: true, read_at: read.awaySince } : {}),
            ...(read.pending?.length ? { waiting: read.pending } : {}),
          });
        }
        if (!input.capability) throw new InboxError("validation_error", `capability: one of ${INBOX_CAPABILITY_AGENT_IDS.join(", ")}.`, { field: "capability" });
        const { key, name } = switchOf(input.capability);
        const on = input.on;
        const by: InboxCapabilityTurnBy = { host: input.agent_host?.trim() || "agent", session: input.agent_session?.trim() || "", name: input.agent_name?.trim() || input.agent_host?.trim() || "Agent" };
        // The agent's own project, by the lookup of the door it came through, so the line lands where it works.
        const projectPath = input.project_path?.trim() || null;
        const resolve = context.resolveProject;
        const project = async () => (projectPath && resolve ? ((await resolve(projectPath).catch(() => null))?.id ?? null) : null);
        const threadId = input.thread_id?.trim() || null;
        const tell = (body: string, thread: string | null = threadId) => caps.tell(by, thread, project, body);
        const told = async (where: string | null, held: boolean) => {
          const id = await tell(capabilityLineText(name, on, where, held));
          return { id, words: id ? ` The person sees it in thread ${id}.` : NO_CHANGE_LINE };
        };
        const state = on ? "on" : "off";
        if (!computer) {
          const before = caps.here()[key];
          if (!before) throw new InboxError("not_offered", `${name} is not offered on this computer.`);
          if (before.on === on) return okComplete(`${name} was already ${state} (this computer). Nothing changed.${on ? servesLine(key) : ""}`, { capabilities: shown(caps.here()) });
          const after = await caps.set(key, on);
          return okComplete(`Turned ${state} ${name} on this computer.${(await told(null, false)).words}${on ? servesLine(key) : ""}`, { capabilities: shown(after) });
        }
        const before = await caps.there(computer, null).catch(() => undefined);
        if (before === null) throw nowhere(computer);
        // Only switches read now decide "already" or "not offered": while it is away, the last it said may have changed.
        const current = before && !before.awaySince ? before.switches : null;
        if (current && !current[key]) throw new InboxError("not_offered", `${name} is not offered on ${before!.name}.`);
        if (current?.[key]?.on === on) return okComplete(`${name} was already ${state} (${before!.name}). Nothing changed.`, { computer: before!.name, capabilities: shown(current) });
        const turned = await caps.there(computer, { key, on });
        if (!turned) throw nowhere(computer);
        if (turned.held) {
          const line = await told(turned.name, true);
          // Not taken there after all (refused, given up, dropped): one more line, in the same thread.
          void turned.settled?.then(({ taken, why }) => (taken ? null : tell(capabilityNotTakenText(name, on, turned.name, why), line.id ?? threadId))).catch(() => {});
          return okComplete(`Asked ${turned.name} to turn ${name} ${state}. ${turned.held}${line.words}`, { computer: turned.name, held: true });
        }
        return okComplete(`Turned ${state} ${name} on ${turned.name}.${(await told(turned.name, false)).words}`, { computer: turned.name, capabilities: shown(turned.switches ?? {}) });
      }),
  );
}
