/**
 * Settings → Capabilities' switches that a linked computer's window shows and turns for this computer
 * (docs/agent-guides/inbox-machines.md, "Capabilities on a linked computer"). Each is the settings key the window's own
 * row writes (`POST /api/inbox/settings { <key>: { on } }`) and the row's name there. Plans (config and its command
 * only) is not one of them.
 */
export const INBOX_CAPABILITY_SWITCHES = [
  { key: "board", name: "Board" },
  { key: "steps", name: "Checklist" },
  { key: "scheduled_threads", name: "Routines" },
  { key: "code_review", name: "Code review" },
  { key: "chapter_diagrams", name: "Chapter diagrams" },
  { key: "system", name: "System" },
  { key: "bro", name: "Bro mode" },
  { key: "float_drafts", name: "Float reply drafts" },
] as const;

export type InboxCapabilitySwitchKey = (typeof INBOX_CAPABILITY_SWITCHES)[number]["key"];

/** `GET /api/inbox/capabilities`: each switch this Inbox offers now, and whether it is on. One it does not offer is absent. */
export type InboxCapabilitySwitches = Partial<Record<InboxCapabilitySwitchKey, { on: boolean }>>;

export const INBOX_CAPABILITY_SWITCH_KEYS: readonly string[] = INBOX_CAPABILITY_SWITCHES.map((s) => s.key);

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
