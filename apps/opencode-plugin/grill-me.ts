/**
 * The grill-me note on OpenCode (packages/shared/inbox/grill-me.ts): when a
 * grill-me skill runs, whoever wrote it, the model also reads a short note
 * saying its questions can go to the Plannotator Inbox as `:::question` cards.
 * Set up beside `plannotator_inbox`, only where the tool was registered and
 * the Inbox reminder is on (`inboxReminder`); never for a subagent.
 *
 * OpenCode 1 (index.ts): a skill is also a slash command (`/grill-me`), so
 * `command.execute.before` adds the note to the command's message as a
 * synthetic text part (the model reads it; the person's message does not show
 * it), and the built-in `skill` tool's `tool.execute.after` appends it to the
 * tool's output. The no-wake wording: a reply does not come back as a turn.
 *
 * OpenCode 2 (server.ts): the `skill` tool's `execute.after` hook
 * (`ctx.tool.hook`) appends it to the result. Not the skill domain's
 * transform, which would rewrite the skill's text for every agent. A skill
 * the person attaches to a prompt gets no note there yet (see the guide).
 *
 * Once per turn: a typed `/grill-me` whose skill then loads `grilling` in the
 * same turn gets one note. A turn starts with the next user message
 * (OpenCode 1 `chat.message`, OpenCode 2's `prompt` session hook).
 */

import { INBOX_TOOL_NAME } from "@plannotator/shared/inbox/connection";
import { grillMeNoteText, isGrillMeSkill } from "@plannotator/shared/inbox/grill-me";

/** The built-in tool that loads a skill (`{ name }`), on both OpenCode runtimes. */
export const SKILL_TOOL = "skill";

/** The skill a `skill` tool call loaded, from its input, or null for another tool. */
export function skillToolName(toolName: unknown, input: unknown): string | null {
  if (toolName !== SKILL_TOOL || !input || typeof input !== "object") return null;
  const name = (input as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

/**
 * Which sessions already have the note in the current turn. OpenCode 1's
 * command marks its session "command" because its own message then arrives
 * through `chat.message`, which must keep the mark rather than start a turn.
 */
export class GrillMeTurns {
  private readonly sessions = new Map<string, "command" | "noted">();

  has(sessionID: string): boolean {
    return this.sessions.has(sessionID);
  }

  /** The note went into a command's message, which `userMessage` will see next. */
  command(sessionID: string): void {
    this.mark(sessionID, "command");
  }

  noted(sessionID: string): void {
    this.mark(sessionID, "noted");
  }

  /** A user message entered the session: a new turn, unless it is the noted command's own. */
  userMessage(sessionID: string): void {
    if (this.sessions.get(sessionID) === "command") this.sessions.set(sessionID, "noted");
    else this.sessions.delete(sessionID);
  }

  private mark(sessionID: string, state: "command" | "noted"): void {
    if (this.sessions.size > 500 && !this.sessions.has(sessionID)) this.sessions.clear();
    this.sessions.set(sessionID, state);
  }
}

// ---------------------------------------------------------------------------
// OpenCode 1

export interface OpenCode1GrillMe {
  /** `command.execute.before`: a grill-me skill typed as a slash command. */
  command(input: { command?: unknown; sessionID: string }, output: { parts: unknown[] }): void;
  /** `chat.message`: a user message entered the session. */
  userMessage(input: { sessionID: string }): void;
  /** `tool.execute.after`: the model loaded a skill. */
  toolAfter(input: { tool?: unknown; sessionID: string; args?: unknown }, output: { output?: unknown }): Promise<void>;
}

/**
 * The OpenCode 1 hooks. `isSubagentSession` answers whether a session is a
 * subagent's (a child session); a lookup that fails should answer false.
 */
export function createOpenCode1GrillMe(deps: {
  isSubagentSession: (sessionID: string) => Promise<boolean>;
  toolName?: string;
}): OpenCode1GrillMe {
  const note = grillMeNoteText(deps.toolName ?? INBOX_TOOL_NAME, { wakes: false });
  const turns = new GrillMeTurns();
  return {
    command(input, output) {
      if (!isGrillMeSkill(input.command) || !Array.isArray(output.parts)) return;
      // A command that runs as a subtask (its agent is a subagent) holds one subtask part: the subagent's.
      if (output.parts.some((part) => (part as { type?: unknown } | null)?.type === "subtask")) return;
      // The command starts a turn of its own (its message is the next `chat.message`): no check for a note before it.
      output.parts.push({ type: "text", text: note, synthetic: true });
      turns.command(input.sessionID);
    },
    userMessage(input) {
      turns.userMessage(input.sessionID);
    },
    async toolAfter(input, output) {
      if (!isGrillMeSkill(skillToolName(input.tool, input.args)) || typeof output.output !== "string") return;
      if (turns.has(input.sessionID)) return;
      if (await deps.isSubagentSession(input.sessionID)) return;
      if (turns.has(input.sessionID)) return;
      output.output = `${output.output}\n\n${note}`;
      turns.noted(input.sessionID);
    },
  };
}

// ---------------------------------------------------------------------------
// OpenCode 2

type ToolResultLike = { content?: unknown; output?: unknown; [key: string]: unknown };

/** A tool result with the note after what the model reads, or null when its shape is not one this knows. */
export function withGrillMeNote(result: ToolResultLike | undefined, note: string): ToolResultLike | null {
  if (!result || typeof result !== "object") return null;
  const content = result.content;
  if (typeof content === "string") return { ...result, content: content ? `${content}\n\n${note}` : note };
  if (Array.isArray(content)) return { ...result, content: [...content, { type: "text", text: note }] };
  // No content: the model reads a text output; anything else is left alone rather than hidden behind the note.
  if (content === undefined && typeof result.output === "string") return { ...result, content: `${result.output}\n\n${note}` };
  return null;
}

/** The part of OpenCode 2's domains the note needs (probed: OpenCode 1.18's context and older V2 hosts lack them). */
export interface GrillMeToolDomainLike {
  hook?: (name: "execute.after", callback: (event: any) => Promise<void> | void) => Promise<unknown> | unknown;
}
export interface GrillMeSessionDomainLike {
  hook?: (name: "prompt", callback: (event: any) => Promise<void> | void) => Promise<unknown> | unknown;
}

/**
 * Registers the OpenCode 2 hooks; false where the host has no tool hook.
 * `isSubagent` answers whether a call is a subagent's (its agent's mode, or a
 * child session). `wakes`: the host delivers an Inbox reply as a turn.
 */
export async function registerGrillMeOpenCode2(
  toolDomain: GrillMeToolDomainLike | undefined,
  sessionDomain: GrillMeSessionDomainLike | undefined,
  deps: { isSubagent: (call: { sessionID: string; agent?: string }) => Promise<boolean>; wakes: boolean; toolName?: string },
): Promise<boolean> {
  const hook = toolDomain?.hook;
  if (typeof hook !== "function") return false;
  const note = grillMeNoteText(deps.toolName ?? INBOX_TOOL_NAME, { wakes: deps.wakes });
  // Without the prompt hook nothing says when a turn starts: every grill-me skill load gets the note.
  let turns: GrillMeTurns | null = null;
  if (typeof sessionDomain?.hook === "function") {
    try {
      const tracked = new GrillMeTurns();
      await sessionDomain.hook("prompt", (event: { sessionID?: unknown }) => {
        if (typeof event?.sessionID === "string") tracked.userMessage(event.sessionID);
      });
      turns = tracked;
    } catch {
      turns = null;
    }
  }
  await hook.call(toolDomain, "execute.after", async (event: {
    tool?: unknown;
    sessionID: string;
    agent?: string;
    input?: unknown;
    status?: unknown;
    result?: ToolResultLike;
  }) => {
    // An execute.after that throws is a defect in the host's tool call: never.
    try {
      if (event?.status !== "completed" || !isGrillMeSkill(skillToolName(event.tool, event.input))) return;
      if (turns?.has(event.sessionID)) return;
      if (await deps.isSubagent({ sessionID: event.sessionID, agent: event.agent })) return;
      if (turns?.has(event.sessionID)) return;
      const next = withGrillMeNote(event.result, note);
      if (!next) return;
      event.result = next;
      turns?.noted(event.sessionID);
    } catch {
      // The skill's result stays as it was.
    }
  });
  return true;
}
