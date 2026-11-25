/**
 * Settings → Capabilities' switches that `plannotator inbox capability` lists and turns, and that an older linked
 * computer's window still shows and turns for this computer (its group, mark `capabilities`). Each is the settings key
 * the window's own row writes (`POST /api/inbox/settings { <key>: { on } }`) and the row's name there. Plans (config
 * and its command only) is not one of them.
 */
export const INBOX_CAPABILITY_SWITCHES = [
  { key: "board", name: "Board", agent: "board" },
  { key: "steps", name: "Checklist", agent: "checklist" },
  { key: "decision_mode", name: "Decision mode", agent: "decision_mode" },
  { key: "scheduled_threads", name: "Routines", agent: "routines" },
  { key: "code_review", name: "Code review", agent: "code_review" },
  { key: "chapter_diagrams", name: "Chapter diagrams", agent: "chapter_diagrams" },
  { key: "system", name: "System", agent: "system" },
  { key: "bro", name: "Bro mode", agent: "bro_mode" },
  { key: "float_drafts", name: "Float reply drafts", agent: "float_drafts" },
] as const;

export type InboxCapabilitySwitchKey = (typeof INBOX_CAPABILITY_SWITCHES)[number]["key"];

/**
 * Whether Settings → Capabilities offers the System switch to everyone (approval "system-inbox", addendum 2026-11-08:
 * in 0.29 System stays off and hidden; it turns on only by config.json `inboxSystem: true`, for testing). The Settings
 * page's `SYSTEM_SETTINGS_ROW_VISIBLE` is this, and agents get System only when it is true. Set it to true when System
 * is announced.
 */
export const INBOX_SYSTEM_SWITCH_SHOWN: boolean = false;

/**
 * The switches an agent may list and turn: exactly those a person sees in Settings → Capabilities, Experimental
 * included. A hidden one (System, while `INBOX_SYSTEM_SWITCH_SHOWN` is false) is not among them.
 */
export const INBOX_CAPABILITY_AGENT_SWITCHES = INBOX_CAPABILITY_SWITCHES.filter((s) => s.key !== "system" || INBOX_SYSTEM_SWITCH_SHOWN);

export type InboxCapabilityAgentId = (typeof INBOX_CAPABILITY_SWITCHES)[number]["agent"];

/** `plannotator inbox capability`'s names for them (docs/agent-guides/inbox-machines.md): the Settings row's name, in snake case. */
export const INBOX_CAPABILITY_AGENT_IDS = INBOX_CAPABILITY_AGENT_SWITCHES.map((s) => s.agent) as [InboxCapabilityAgentId, ...InboxCapabilityAgentId[]];

/** `GET /api/inbox/capabilities`: each switch this Inbox offers now, and whether it is on. One it does not offer is absent. */
export type InboxCapabilitySwitches = Partial<Record<InboxCapabilitySwitchKey, { on: boolean }>>;

export const INBOX_CAPABILITY_SWITCH_KEYS: readonly string[] = INBOX_CAPABILITY_SWITCHES.map((s) => s.key);

/**
 * The switches that are one set across linked computers (docs/agent-guides/inbox-machines.md, "One set of
 * capabilities"): every switch a person sees in Settings → Capabilities, Experimental included (`grid` is the settings'
 * `experimental` one; `decision_mode` is its own setting, on by default). A flip on any linked computer applies on all of them, the newer flip
 * winning. System is not among them while its row is hidden (`INBOX_SYSTEM_SWITCH_SHOWN`). A new switch is one line
 * here and one in the server's host (packages/server/inbox-capability-set.ts).
 */
export const INBOX_CAPABILITY_SET_KEYS = [
  "board",
  "steps",
  "scheduled_threads",
  "code_review",
  "chapter_diagrams",
  "bro",
  "float_drafts",
  "decision_mode",
  "grid",
] as const;

export type InboxCapabilitySetKey = (typeof INBOX_CAPABILITY_SET_KEYS)[number];

/** The switches of a settings answer (any object): each one it carries as `{ on: boolean }`. */
export function inboxCapabilitySwitchesOf(settings: unknown): InboxCapabilitySwitches {
  const out: InboxCapabilitySwitches = {};
  if (!settings || typeof settings !== "object") return out;
  for (const { key } of INBOX_CAPABILITY_SWITCHES) {
    const value = (settings as Record<string, unknown>)[key];
    if (value && typeof value === "object" && typeof (value as { on?: unknown }).on === "boolean") out[key] = { on: (value as { on: boolean }).on };
  }
  return out;
}
