/**
 * The Inbox's preferences, in one list: every setting a person changes in the window that the Inbox keeps, by a
 * short dotted key that never changes once shipped (`appearance.theme`, `sidebar.hidden`). GET and POST
 * /api/inbox/prefs (packages/server/inbox-prefs.ts) read and write them through the routes the window already uses,
 * so there is one stored value and one check per setting. The words (label, meaning, where) are in
 * inbox-prefs-words.ts, pending the owner's approval.
 *
 * Each entry says its type and allowed values, its default (what `reset` writes), where it is stored (`stored`: a
 * config.json path, or `file:<name>` for a file in the data dir; inbox-prefs-coverage.test.ts holds these to what
 * the routes write), and its scope:
 * - `person`: the person's choice wherever they use the Inbox.
 * - `device`: about this computer by nature (its agents' files, a folder path, this browser's address).
 *
 * A `secret` (an API key, a wake key) is set like any other and never read back: reads say "set" or "not set".
 * `cloud_agents.<id>.wake` is one key per cloud agent that wakes (`inboxCloudWakePref`).
 */
import { DEFAULT_FAVICON_STYLE } from "./favicon-style";
import { INBOX_AGENT_IDS, INBOX_AGENT_LABELS, INBOX_NOTE_AGENT_IDS, INBOX_PROMPT_HOSTS, INBOX_ROWS_DEFAULT, INBOX_ROWS_OPTIONS, INBOX_SAVED_REACTIONS_MAX, INBOX_SOUND_DEFAULT_VOLUME, INBOX_SOUND_MAX_VOLUME, INBOX_SOUND_MIN_VOLUME, INBOX_TEXT_SIZE_DEFAULT, INBOX_TEXT_SIZES, type InboxAgentId } from "./inbox-types";
import { INBOX_SIDEBAR_DEFAULT, INBOX_SIDEBAR_ITEMS } from "./inbox-sidebar";
import { INBOX_PREF_WORDS, inboxPrefCloudWakeWords, inboxPrefHostReminderWords, inboxPrefHostRulesWords, inboxPrefNoteWords, inboxPrefReachWords, inboxPrefReminderWords, inboxPrefToolWords, inboxPrefUnknownWords, type InboxPrefWords } from "./inbox-prefs-words";

export type InboxPrefScope = "person" | "device";

export type InboxPrefType =
  | { kind: "boolean" }
  | { kind: "choice"; values: readonly string[]; nullable?: true }
  | { kind: "number"; min: number; max: number; values?: readonly number[] }
  | { kind: "text"; max: number; nullable?: true; pattern?: { test: RegExp; words: string } }
  | { kind: "list"; values: readonly string[]; ordered?: true }
  | { kind: "reactions"; max: number }
  /** Free names (Tailscale logins): each one word, each once. */
  | { kind: "logins"; max: number }
  | { kind: "wake" };

export type InboxPrefValue = boolean | number | string | null | readonly string[] | readonly { emoji: string; label?: string }[] | Readonly<{ url: string; key: string }>;

export interface InboxPref extends InboxPrefWords {
  key: string;
  /** The key's first part. */
  group: string;
  type: InboxPrefType;
  default: InboxPrefValue;
  scope: InboxPrefScope;
  stored: string;
  /** Read by the Inbox at its next start only. */
  nextStart?: true;
  /** No default to put back (connecting an agent, writing its note): `reset` refuses it and "all" leaves it. */
  noReset?: true;
  /** Never read back; "all" leaves it (a reset names it). */
  secret?: true;
}

/** The hosts with a `plannotator_inbox` tool switch, and those with a session-start reminder (shared/config.ts's lists). */
export const INBOX_PREF_TOOL_HOSTS = ["claude-code", "pi", "opencode", "dsh", "cline", "openclaw", "hermes"] as const;
export const INBOX_PREF_REMINDER_HOSTS = ["claude-code", "pi", "opencode"] as const;
/** Their defaults with nothing saved (shared/config.ts `INBOX_TOOL_DEFAULTS`). */
const TOOL_DEFAULTS: Readonly<Record<(typeof INBOX_PREF_TOOL_HOSTS)[number], boolean>> = { "claude-code": true, pi: false, opencode: false, dsh: false, cline: false, openclaw: false, hermes: false };

const BOOLEAN = { kind: "boolean" } as const;
const choice = (...values: string[]): InboxPrefType => ({ kind: "choice", values });
/** shared/inbox/connection.ts `INBOX_REMINDER_MAX_CHARS`, core/guide.ts `GUIDE_EXTRA_INSTRUCTIONS_MAX_CHARS`. */
const REMINDER_MAX = 9000;
const GUIDE_MAX = 12_000;
const PROMPT_TEXT: InboxPrefType = { kind: "text", max: REMINDER_MAX, nullable: true };
const PALETTE: InboxPrefType = { kind: "text", max: 64, pattern: { test: /^[a-z0-9][a-z0-9-]{0,63}$/, words: "a palette id, as Settings → General → Colors lists them (plannotator, plannotator-graphite, …)" } };
const HIDEABLE = INBOX_SIDEBAR_ITEMS.filter((item) => item.hideable).map((item) => item.id);
const STACKED = INBOX_SIDEBAR_ITEMS.filter((item) => item.place === "stack").map((item) => item.id);

type Entry = Omit<InboxPref, "group" | keyof InboxPrefWords> & { words?: InboxPrefWords };

const entries: Entry[] = [
  { key: "appearance.theme", type: choice("light", "dark", "system"), default: "dark", scope: "person", stored: "theme.mode" },
  { key: "appearance.light_palette", type: PALETTE, default: "plannotator", scope: "person", stored: "theme.light" },
  { key: "appearance.dark_palette", type: PALETTE, default: "plannotator", scope: "person", stored: "theme.dark" },
  { key: "appearance.text_size", type: { kind: "number", min: 12, max: 15, values: INBOX_TEXT_SIZES }, default: INBOX_TEXT_SIZE_DEFAULT, scope: "person", stored: "inboxTextSize" },
  { key: "appearance.tab_icon", type: choice("glass", "yellow", "totman"), default: DEFAULT_FAVICON_STYLE, scope: "person", stored: "favicon" },
  { key: "sound.on", type: BOOLEAN, default: true, scope: "person", stored: "inboxSound.enabled" },
  { key: "sound.volume", type: { kind: "number", min: INBOX_SOUND_MIN_VOLUME, max: INBOX_SOUND_MAX_VOLUME }, default: INBOX_SOUND_DEFAULT_VOLUME, scope: "person", stored: "inboxSound.volume" },
  { key: "notifications.on", type: BOOLEAN, default: true, scope: "person", stored: "inboxNotifications.enabled" },
  { key: "notifications.ask_dismissed", type: BOOLEAN, default: false, scope: "person", stored: "inboxNotifications.dismissed" },
  { key: "list.rows", type: { kind: "list", values: INBOX_ROWS_OPTIONS }, default: INBOX_ROWS_DEFAULT, scope: "person", stored: "inboxRows" },
  { key: "list.mark_read_warning", type: BOOLEAN, default: true, scope: "person", stored: "inboxMarkReadWarning" },
  { key: "sidebar.hidden", type: { kind: "list", values: HIDEABLE }, default: INBOX_SIDEBAR_DEFAULT.hidden, scope: "person", stored: "inboxSidebar.hidden" },
  { key: "sidebar.top", type: { kind: "list", values: STACKED, ordered: true }, default: INBOX_SIDEBAR_DEFAULT.top, scope: "person", stored: "inboxSidebar.top" },
  { key: "sidebar.bottom", type: { kind: "list", values: STACKED, ordered: true }, default: INBOX_SIDEBAR_DEFAULT.bottom, scope: "person", stored: "inboxSidebar.bottom" },
  { key: "reactions.saved", type: { kind: "reactions", max: INBOX_SAVED_REACTIONS_MAX }, default: [], scope: "person", stored: "inboxReactions" },
  { key: "diff.style", type: choice("split", "unified"), default: "split", scope: "person", stored: "diffOptions.diffStyle" },
  { key: "diff.overflow", type: choice("scroll", "wrap"), default: "scroll", scope: "person", stored: "diffOptions.overflow" },
  { key: "diff.indicators", type: choice("bars", "classic", "none"), default: "bars", scope: "person", stored: "diffOptions.diffIndicators" },
  { key: "diff.line_diff", type: choice("word-alt", "word", "char", "none"), default: "word-alt", scope: "person", stored: "diffOptions.lineDiffType" },
  { key: "diff.line_numbers", type: BOOLEAN, default: true, scope: "person", stored: "diffOptions.showLineNumbers" },
  { key: "diff.background", type: BOOLEAN, default: true, scope: "person", stored: "diffOptions.showDiffBackground" },
  { key: "diff.background_intensity", type: choice("subtle", "normal", "strong"), default: "subtle", scope: "person", stored: "diffOptions.lineBgIntensity" },
  { key: "diff.tab_size", type: { kind: "number", min: 1, max: 8 }, default: 2, scope: "person", stored: "diffOptions.tabSize" },
  { key: "decisions.post_to", type: choice("description", "comment", "both"), default: "description", scope: "person", stored: "inboxDecisionsPostTo" },
  { key: "general.plannotator_localhost", type: BOOLEAN, default: false, scope: "device", stored: "urlHost", nextStart: true },
  ...INBOX_AGENT_IDS.map((id): Entry => ({ key: `agents.${id}.reach`, type: BOOLEAN, default: true, scope: "device", stored: "file:inbox/agents.json", noReset: true, words: inboxPrefReachWords(INBOX_AGENT_LABELS[id]) })),
  ...INBOX_PREF_TOOL_HOSTS.map((host): Entry => ({ key: `agents.${host}.tool`, type: BOOLEAN, default: TOOL_DEFAULTS[host], scope: "device", stored: `inboxTool.${host}`, words: inboxPrefToolWords(INBOX_AGENT_LABELS[host]) })),
  ...INBOX_PREF_REMINDER_HOSTS.map((host): Entry => ({ key: `agents.${host}.reminder`, type: BOOLEAN, default: true, scope: "device", stored: `inboxReminder.${host}`, words: inboxPrefReminderWords(INBOX_AGENT_LABELS[host]) })),
  // Cursor's note is copied by hand into its app, so there is nothing to switch.
  ...INBOX_NOTE_AGENT_IDS.filter((id) => id !== "cursor").map((id): Entry => ({ key: `agents.${id}.note`, type: BOOLEAN, default: false, scope: "device", stored: "file:inbox/agent-notes.json", noReset: true, words: inboxPrefNoteWords(INBOX_AGENT_LABELS[id as InboxAgentId]) })),
  { key: "prompts.reminder", type: PROMPT_TEXT, default: null, scope: "person", stored: "prompts.inbox.reminder" },
  { key: "prompts.rules", type: PROMPT_TEXT, default: null, scope: "person", stored: "prompts.inbox.rules" },
  ...INBOX_PROMPT_HOSTS.flatMap((host): Entry[] => [
    { key: `prompts.${host}.reminder`, type: PROMPT_TEXT, default: null, scope: "person", stored: `prompts.inbox.runtimes.${host}.reminder`, words: inboxPrefHostReminderWords(INBOX_AGENT_LABELS[host]) },
    { key: `prompts.${host}.rules`, type: PROMPT_TEXT, default: null, scope: "person", stored: `prompts.inbox.runtimes.${host}.rules`, words: inboxPrefHostRulesWords(INBOX_AGENT_LABELS[host]) },
  ]),
  { key: "prompts.guide", type: { kind: "text", max: GUIDE_MAX, nullable: true }, default: null, scope: "person", stored: "file:guide-instructions.md" },
  { key: "launch.on", type: BOOLEAN, default: true, scope: "person", stored: "inboxLaunch.enabled" },
  { key: "launch.scratch_dir", type: { kind: "text", max: 4096, nullable: true }, default: null, scope: "device", stored: "inboxLaunch.scratchDir" },
  { key: "launch.full_permissions", type: BOOLEAN, default: false, scope: "device", stored: "inboxLaunch.fullPermissions" },
  { key: "launch.settings_file", type: { kind: "text", max: 4096, nullable: true }, default: null, scope: "device", stored: "inboxLaunch.settingsFile" },
  { key: "capabilities.board", type: BOOLEAN, default: false, scope: "person", stored: "inboxBoard" },
  { key: "capabilities.checklist", type: BOOLEAN, default: false, scope: "person", stored: "inboxSteps" },
  { key: "capabilities.code_review", type: BOOLEAN, default: false, scope: "person", stored: "inboxCodeReview" },
  { key: "capabilities.chapter_diagrams", type: BOOLEAN, default: true, scope: "person", stored: "inboxChapterDiagrams" },
  { key: "capabilities.system", type: BOOLEAN, default: false, scope: "person", stored: "inboxSystem" },
  { key: "capabilities.shape", type: BOOLEAN, default: false, scope: "person", stored: "inboxShape" },
  { key: "experimental.decision_mode", type: BOOLEAN, default: false, scope: "person", stored: "experimental.decisionMode" },
  { key: "experimental.bro", type: BOOLEAN, default: false, scope: "person", stored: "inboxBro" },
  { key: "experimental.float_drafts", type: BOOLEAN, default: false, scope: "person", stored: "inboxFloatDrafts" },
  { key: "updates.check", type: BOOLEAN, default: true, scope: "person", stored: "updateCheck" },
  { key: "updates.auto_install", type: BOOLEAN, default: false, scope: "person", stored: "autoUpdate" },
  { key: "reviews.risk_rules", type: { kind: "text", max: 20_000 }, default: "", scope: "person", stored: "inboxPullRisk.rules" },
  // The agents this computer has installed (Reviews → Risk rules lists them): the route says which.
  { key: "reviews.risk_agent", type: { kind: "text", max: 64, nullable: true }, default: null, scope: "device", stored: "inboxPullRisk.provider" },
  { key: "reviews.risk_model", type: { kind: "text", max: 200, nullable: true }, default: null, scope: "device", stored: "inboxPullRisk.model" },
  { key: "voice.on", type: BOOLEAN, default: false, scope: "person", stored: "inboxVoice.on" },
  { key: "voice.phones_only", type: BOOLEAN, default: false, scope: "person", stored: "inboxVoice.phonesOnly" },
  { key: "voice.engine", type: choice("codex", "api"), default: "codex", scope: "device", stored: "inboxVoice.engine" },
  // inbox-voice.ts's check of a key: printable, no spaces.
  { key: "voice.api_key", type: { kind: "text", max: 512, nullable: true, pattern: { test: /^[\x21-\x7e]{8,512}$/, words: "an OpenAI API key" } }, default: null, scope: "device", stored: "file:inbox/voice-key", secret: true },
  { key: "access.tailnet_window", type: BOOLEAN, default: false, scope: "device", stored: "inboxTailscale" },
  { key: "access.tailnet_allow", type: { kind: "logins", max: 50 }, default: [], scope: "device", stored: "inboxTailscaleAllow" },
  { key: "access.this_wifi", type: BOOLEAN, default: false, scope: "device", stored: "file:inbox.json" },
  { key: "access.tailnet_door", type: BOOLEAN, default: false, scope: "device", stored: "file:inbox.json" },
];

/** Every preference, in the order Settings shows them. */
export const INBOX_PREFS: readonly InboxPref[] = entries.map(({ words, ...entry }) => {
  const said = words ?? INBOX_PREF_WORDS[entry.key];
  if (!said) throw new Error(`inbox-prefs: no words for ${entry.key}`);
  return { ...entry, group: entry.key.slice(0, entry.key.indexOf(".")), ...said };
});

const BY_KEY: ReadonlyMap<string, InboxPref> = new Map(INBOX_PREFS.map((pref) => [pref.key, pref]));

const CLOUD_WAKE = /^cloud_agents\.([0-9a-f]{12})\.wake$/;

/** A cloud agent's wake key, for `cloud.<id>`; `name` is the agent's, for its words. */
export function inboxCloudWakePref(id: string, name = "This cloud agent"): InboxPref {
  return { key: `cloud_agents.${id}.wake`, group: "cloud_agents", type: { kind: "wake" }, default: null, scope: "device", stored: "file:inbox/cloud-agents.json", noReset: true, secret: true, ...inboxPrefCloudWakeWords(name) };
}

export const inboxPref = (key: string): InboxPref | undefined => {
  const wake = CLOUD_WAKE.exec(key);
  return BY_KEY.get(key) ?? (wake ? inboxCloudWakePref(wake[1]!) : undefined);
};
export const INBOX_PREF_GROUPS: readonly string[] = [...new Set([...INBOX_PREFS.map((pref) => pref.group), "cloud_agents"])];

/** The allowed values in words, for a catalogue line and a refusal. */
export function inboxPrefAllowed(type: InboxPrefType): string {
  const or = (values: readonly (string | number)[]) => (values.length <= 1 ? values.join("") : `${values.slice(0, -1).join(", ")} or ${values.at(-1)}`);
  switch (type.kind) {
    case "boolean":
      return "true or false";
    case "choice":
      return or([...type.values, ...(type.nullable ? ["null"] : [])]);
    case "number":
      return type.values ? or(type.values) : `a whole number from ${type.min} to ${type.max}`;
    case "text":
      return `${type.pattern ? type.pattern.words : `text, up to ${type.max.toLocaleString("en-US")} characters`}${type.nullable ? ", or null" : ""}`;
    case "list":
      return `a list${type.ordered ? ", in order," : ""} of ${or(type.values)}`;
    case "reactions":
      return `a list of up to ${type.max} { emoji, label? }`;
    case "logins":
      return `a list of up to ${type.max} logins, each once`;
    case "wake":
      return "{ url, key }: the routine's https:// webhook address and its key";
  }
}

export type InboxPrefCheck = { ok: true; value: InboxPrefValue } | { ok: false; error: string };

/** One value for one preference, checked by its type. A refusal names the key, the allowed values and what came. */
export function inboxPrefCheck(pref: InboxPref, value: unknown): InboxPrefCheck {
  // A secret's refusal never repeats what came.
  const refuse = (): InboxPrefCheck => ({ ok: false, error: pref.secret ? `${pref.key}: ${inboxPrefAllowed(pref.type)}.` : `${pref.key}: ${inboxPrefAllowed(pref.type)} (got ${JSON.stringify(value) ?? "nothing"}).` });
  const type = pref.type;
  switch (type.kind) {
    case "boolean":
      return typeof value === "boolean" ? { ok: true, value } : refuse();
    case "choice":
      if (value === null && type.nullable) return { ok: true, value: null };
      return typeof value === "string" && type.values.includes(value) ? { ok: true, value } : refuse();
    case "number":
      if (typeof value !== "number" || !Number.isInteger(value) || value < type.min || value > type.max) return refuse();
      return !type.values || type.values.includes(value) ? { ok: true, value } : refuse();
    case "text":
      if (value === null && type.nullable) return { ok: true, value: null };
      if (typeof value !== "string" || value.length > type.max) return refuse();
      return !type.pattern || type.pattern.test.test(value) ? { ok: true, value } : refuse();
    case "list": {
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && type.values.includes(item))) return refuse();
      return new Set(value).size === value.length ? { ok: true, value: value as string[] } : refuse();
    }
    case "reactions": {
      const entry = (item: unknown) =>
        !!item && typeof item === "object" && !Array.isArray(item) && typeof (item as { emoji?: unknown }).emoji === "string" && ((item as { label?: unknown }).label === undefined || typeof (item as { label?: unknown }).label === "string") && Object.keys(item).every((k) => k === "emoji" || k === "label");
      return Array.isArray(value) && value.length <= type.max && value.every(entry) ? { ok: true, value: value as { emoji: string; label?: string }[] } : refuse();
    }
    case "logins": {
      const login = (item: unknown) => typeof item === "string" && item.length > 0 && item.length <= 320 && !/[\s\u0000-\u001f\u007f]/.test(item);
      if (!Array.isArray(value) || value.length > type.max || !value.every(login)) return refuse();
      return new Set(value.map((item: string) => item.toLowerCase())).size === value.length ? { ok: true, value: value as string[] } : refuse();
    }
    case "wake": {
      const wake = value as { url?: unknown; key?: unknown } | null;
      const ok = !!wake && typeof wake === "object" && !Array.isArray(wake) && Object.keys(wake).every((k) => k === "url" || k === "key") && typeof wake.url === "string" && wake.url.length <= 2048 && typeof wake.key === "string" && wake.key.length > 0 && wake.key.length <= 4096;
      return ok ? { ok: true, value: { url: wake.url as string, key: wake.key as string } } : refuse();
    }
  }
}

export type InboxPrefsChange =
  | { ok: true; values: Map<InboxPref, InboxPrefValue> }
  | { ok: false; status: 422; code: "unknown_pref" | "validation_error"; key: string | null; error: string };

/**
 * A POST body's `set` (key to value) and `reset` (keys, or "all": every key with a default, secrets left), checked in
 * full before anything is written: the first key the list does not know, or a value its type refuses, ends the whole
 * call. `reset` puts the default; a key named twice is refused.
 */
export function inboxPrefsChange(body: { set?: unknown; reset?: unknown }): InboxPrefsChange {
  const values = new Map<InboxPref, InboxPrefValue>();
  const refuse = (key: string | null, error: string, code: "unknown_pref" | "validation_error" = "validation_error"): InboxPrefsChange => ({ ok: false, status: 422, code, key, error });
  const set = body.set;
  if (set !== undefined && (!set || typeof set !== "object" || Array.isArray(set))) return refuse(null, "set: an object of preference key to value.");
  const reset = body.reset;
  const resetAll = reset === "all";
  if (reset !== undefined && !resetAll && !(Array.isArray(reset) && reset.every((key) => typeof key === "string"))) return refuse(null, 'reset: a list of preference keys, or "all".');
  const named = Object.entries((set ?? {}) as Record<string, unknown>);
  const resetKeys = resetAll ? INBOX_PREFS.filter((pref) => !pref.noReset && !pref.secret).map((pref) => pref.key) : ((reset ?? []) as string[]);
  if (named.length === 0 && resetKeys.length === 0) return refuse(null, "set or reset is required.");
  const take = (key: string): InboxPref | InboxPrefsChange => {
    const pref = inboxPref(key);
    if (!pref) return refuse(key, inboxPrefUnknownWords(key), "unknown_pref");
    if (values.has(pref)) return refuse(key, `${key}: named twice.`);
    return pref;
  };
  for (const [key, value] of named) {
    const pref = take(key);
    if ("ok" in pref) return pref;
    const checked = inboxPrefCheck(pref, value);
    if (!checked.ok) return refuse(key, (checked as { error: string }).error);
    values.set(pref, checked.value);
  }
  for (const key of resetKeys) {
    const pref = take(key);
    if ("ok" in pref) return pref;
    if (pref.noReset) return refuse(key, `${key}: has no default to put back; set it to true or false.`);
    values.set(pref, pref.default);
  }
  return { ok: true, values };
}
