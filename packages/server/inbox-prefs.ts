/**
 * GET and POST /api/inbox/prefs: the Inbox's preference list (core inbox-prefs.ts) read from what the window's own
 * routes answer, and written through those routes, one in-process request each with the caller's own headers. So a
 * preference has one stored value, one check and one guard: its route's. Inbox-only (Bun).
 *
 * A write is checked in full before anything is written: every key against the list, every value against its type,
 * and every key not offered now (a held switch, a route this Inbox does not serve). Then the routes run
 * in a fixed order, the settings route first (it checks all its keys before it writes any). When a route refuses, the
 * answer is that refusal with `saved`, the keys an earlier route already wrote.
 *
 * `inboxPrefKeysOf` maps a route's body back to the keys it touched, for `event: prefs`.
 */
import { inboxCloudPresetWakes, type InboxCloudPreset } from "@plannotator/core/inbox-cloud";
import { INBOX_PREFS, inboxCloudWakePref, inboxPref, inboxPrefAllowed, inboxPrefsChange, type InboxPref, type InboxPrefValue } from "@plannotator/core/inbox-prefs";
import { INBOX_SIDEBAR_DEFAULT, inboxSidebarRead, type InboxSidebarLayout } from "@plannotator/core/inbox-sidebar";
import { INBOX_ROWS_DEFAULT } from "@plannotator/core/inbox-types";
import { resolveInboxTailscaleAllow, type PlannotatorConfig } from "@plannotator/shared/config";

export type InboxPrefRoute = "settings" | "agents" | "launch" | "decisions" | "risk" | "voice_key" | "tailscale_allow" | "lan" | "tailnet" | "cloud_wake";

export const INBOX_PREF_ROUTE_PATHS: Readonly<Record<Exclude<InboxPrefRoute, "cloud_wake">, string>> = {
  settings: "/api/inbox/settings",
  agents: "/api/inbox/agents",
  launch: "/api/inbox/launch/settings",
  decisions: "/api/inbox/settings/decisions-post",
  risk: "/api/inbox/pulls/risk",
  voice_key: "/api/inbox/voice/key",
  tailscale_allow: "/api/inbox/settings/tailscale-allow",
  lan: "/api/inbox/lan",
  tailnet: "/api/inbox/tailnet",
};
/**
 * The order a write runs the routes in: the logins let in before the settings route (which can turn the window over
 * the tailnet on, the moment they are read); the settings route checks every key it takes before it writes one.
 */
const ROUTE_ORDER: readonly InboxPrefRoute[] = ["tailscale_allow", "settings", "launch", "agents", "decisions", "risk", "voice_key", "lan", "tailnet", "cloud_wake"];

type Json = Record<string, unknown>;

/** Every field POST /api/inbox/settings takes (inbox.ts refuses a body with none of them). */
export const INBOX_SETTINGS_FIELDS = [
  "inbox_tool",
  "notifications",
  "sound",
  "tailscale",
  "theme",
  "text_size",
  "favicon",
  "reactions",
  "reaction_change",
  "rows",
  "rows_undo",
  "rows_by",
  "sidebar",
  "diff_style",
  "diff_options",
  "experimental",
  "tour",
  "prompts",
  "board",
  "steps",
  "bro",
  "float_drafts",
  "mark_read_warning",
  "code_review",
  "shape",
  "system",
  "chapter_diagrams",
  "cookie_host",
  "voice",
  "update_check",
  "auto_update",
] as const;

/**
 * The settings fields, and fields of them, that no preference key writes, each with why. Anything the route takes
 * that is neither here nor a key's field fails inbox-prefs-coverage.test.ts.
 */
export const INBOX_SETTINGS_NOT_PREFS: Readonly<Record<string, string>> = {
  inbox_tool: "agents.<host>.tool writes the same switch through Settings → Agents' route",
  reaction_change: "one edit of reactions.saved",
  rows_undo: "an action: puts back the look before the last save",
  rows_by: "who made a rows change",
  diff_style: "the older name of diff.style",
  tour: "one-time stamps (seen, finished, skipped): the intros' own write, with the reveal queue",
  "notifications.allowed_origin": "the window that may notify, set by that window",
};

/** What a read is made from: the settings answer this caller gets, config.json, and what the other routes answer it. */
export interface InboxPrefsSources {
  settings: Json;
  config: PlannotatorConfig;
  /** GET /api/inbox/agents' rows; null when not read. */
  agents: readonly Json[] | null;
  /** The phones' doors (GET /api/inbox/lan, /api/inbox/tailnet): null when not read, or this Inbox serves no phones. */
  devices?: { lan: boolean | null; tailnet: boolean | null } | null;
  /** The cloud agents as Settings → Cloud agents lists them (`session`, `name`, `preset`, `wake`); null when not read. */
  cloud?: readonly Json[] | null;
}

/** Which reads a call needs past the settings answer and config.json: for these keys, or (null) the whole list. */
export function inboxPrefsNeeds(keys: Iterable<string> | null): { agents: boolean; devices: boolean; cloud: boolean } {
  const list = keys === null ? null : [...keys];
  const any = (test: (key: string) => boolean) => list === null || list.some(test);
  return { agents: any((key) => key.startsWith("agents.")), devices: any((key) => key === "access.this_wifi" || key === "access.tailnet_door"), cloud: any((key) => key.startsWith("cloud_agents.")) };
}

interface Binding {
  route: InboxPrefRoute;
  /** Its route's path when not the route's own (a cloud agent's). */
  path?: string;
  /** The body field it writes; on the agents route, the switch beside `agent`. */
  field: string;
  agent?: string;
  /** Undefined: not offered now (a held switch, a row this Inbox does not show). */
  read: (s: InboxPrefsSources) => InboxPrefValue | undefined;
  /** Its part of the route's body, over what the call already holds for that route. */
  write: (value: InboxPrefValue, s: InboxPrefsSources, pending: Json) => Json;
}

const obj = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null);
const at = (value: unknown, ...path: string[]): unknown => path.reduce<unknown>((node, key) => obj(node)?.[key], value);
const orDefault = (key: string, value: unknown): InboxPrefValue => (value === undefined || value === null ? inboxPref(key)!.default : (value as InboxPrefValue));
const onOf = (s: InboxPrefsSources, field: string): boolean | undefined => (typeof at(s.settings, field, "on") === "boolean" ? (at(s.settings, field, "on") as boolean) : undefined);

const setting = (field: string, read: Binding["read"], write: (value: InboxPrefValue) => unknown): Binding => ({
  route: "settings",
  field,
  read,
  write: (value) => ({ [field]: write(value) }),
});
const switchOf = (key: string, field: string): Binding => setting(field, (s) => onOf(s, field) ?? orDefault(key, undefined), (on) => ({ on }));
/** A switch the settings answer leaves out while it is held or its row is hidden: not offered then. */
const heldSwitchOf = (field: string): Binding => setting(field, (s) => onOf(s, field), (on) => ({ on }));

const sidebarNow = (s: InboxPrefsSources, pending: Json): InboxSidebarLayout => inboxSidebarRead(pending.sidebar) ?? inboxSidebarRead(s.settings.sidebar) ?? INBOX_SIDEBAR_DEFAULT;
const sidebar = (part: "hidden" | "top" | "bottom"): Binding => ({
  route: "settings",
  field: "sidebar",
  read: (s) => (inboxSidebarRead(s.settings.sidebar) ?? INBOX_SIDEBAR_DEFAULT)[part],
  write: (value, s, pending) => {
    const now = sidebarNow(s, pending);
    const list = value as string[];
    if (part === "hidden") return { sidebar: { ...now, hidden: list } };
    // An item named for one stack leaves the other; one left unnamed takes its default place (core inboxSidebarRead).
    const other = part === "top" ? "bottom" : "top";
    return { sidebar: { ...now, [part]: list, [other]: now[other].filter((id) => !list.includes(id)) } };
  },
});

const DIFF_WIRE: Readonly<Record<string, string>> = {
  "diff.style": "diff_style",
  "diff.overflow": "overflow",
  "diff.indicators": "indicators",
  "diff.line_diff": "line_diff_type",
  "diff.line_numbers": "line_numbers",
  "diff.background": "background",
  "diff.background_intensity": "background_intensity",
  "diff.tab_size": "tab_size",
};

const agentRow = (s: InboxPrefsSources, id: string): Json | undefined => s.agents?.find((row) => row.id === id);
/** A switch of Settings → Agents: offered while that agent's row shows it. */
const agentSwitch = (id: string, field: "reach" | "tool" | "reminder" | "note"): Binding => ({
  route: "agents",
  field,
  agent: id,
  read: (s) => {
    const part = obj(agentRow(s, id)?.[field]);
    if (!part) return undefined;
    if (field === "note") return part.state === "added" || part.state === "edited" ? true : part.state === "absent" ? false : undefined;
    return typeof part.on === "boolean" ? part.on : undefined;
  },
  write: (value) => ({ agent: id, [field]: value }),
});

const promptPath = (key: string): string[] => {
  const [, a, b] = key.split(".");
  return b ? ["inbox", "runtimes", a!, b] : a === "guide" ? ["guide"] : ["inbox", a!];
};
const nest = (path: readonly string[], value: unknown): Json => path.reduceRight<Json>((inner, key) => ({ [key]: inner }), value as Json);

const launchField: Readonly<Record<string, string>> = { "launch.on": "enabled", "launch.scratch_dir": "scratch_dir", "launch.full_permissions": "full_permissions", "launch.settings_file": "settings_file" };
const riskField: Readonly<Record<string, "rules" | "provider" | "model">> = { "reviews.risk_rules": "rules", "reviews.risk_agent": "provider", "reviews.risk_model": "model" };
/** Risk rules exist only while Code review is on (the route answers 409 otherwise), as the settings answer says. */
const riskShown = (s: InboxPrefsSources): boolean => at(s.settings, "code_review", "on") === true;

function bindingOf(pref: InboxPref): Binding {
  const key = pref.key;
  const [group, name, part] = key.split(".") as [string, string, string | undefined];
  if (group === "agents") return agentSwitch(name, part as "reach" | "tool" | "reminder" | "note");
  if (group === "prompts") {
    const path = promptPath(key);
    const read: Binding["read"] = (s) => (key === "prompts.guide" ? ((at(s.settings, "prompts", "guide", "text") as string | null) ?? null) : ((at(s.config.prompts, ...path) as string | undefined) ?? null));
    return setting("prompts", read, (value) => nest(path, value));
  }
  if (group === "diff") {
    const wire = DIFF_WIRE[key]!;
    return { route: "settings", field: "diff_options", read: (s) => orDefault(key, at(s.settings, "diff_options", wire)), write: (value) => ({ diff_options: { [wire]: value } }) };
  }
  if (group === "launch") {
    const field = launchField[key]!;
    return {
      route: "launch",
      field,
      read: (s) => {
        const launch = obj(s.settings.launch);
        if (!launch || launch.unsupported === true) return undefined;
        if (field === "enabled") return launch.enabled === true;
        // Read while launch is on only: off, the settings answer leaves these out and the route refuses them.
        return launch.enabled === true ? orDefault(key, field === "scratch_dir" ? (s.config.inboxLaunch?.scratchDir ?? null) : launch[field]) : undefined;
      },
      write: (value) => ({ [field]: value }),
    };
  }
  if (group === "reviews") {
    const field = riskField[key]!;
    return {
      route: "risk",
      field,
      read: (s) => (riskShown(s) ? orDefault(key, s.config.inboxPullRisk?.[field]) : undefined),
      write: (value, s, pending) => {
        const saved = s.config.inboxPullRisk ?? {};
        const base = { rules: saved.rules ?? "", provider: saved.provider ?? null, model: saved.model ?? null, ...pending };
        return { ...base, [field]: value };
      },
    };
  }
  switch (key) {
    case "appearance.theme":
      return setting("theme", (s) => orDefault(key, at(s.settings, "theme", "mode")), (mode) => ({ mode }));
    case "appearance.light_palette":
      return setting("theme", (s) => orDefault(key, at(s.settings, "theme", "light")), (light) => ({ light }));
    case "appearance.dark_palette":
      return setting("theme", (s) => orDefault(key, at(s.settings, "theme", "dark")), (dark) => ({ dark }));
    case "appearance.text_size":
      return setting("text_size", (s) => orDefault(key, s.settings.text_size), (v) => v);
    case "appearance.tab_icon":
      return setting("favicon", (s) => orDefault(key, s.settings.favicon), (v) => v);
    case "sound.on":
      return setting("sound", (s) => orDefault(key, at(s.settings, "sound", "enabled")), (enabled) => ({ enabled }));
    case "sound.volume":
      return setting("sound", (s) => orDefault(key, at(s.settings, "sound", "volume")), (volume) => ({ volume }));
    case "notifications.on":
      return setting("notifications", (s) => orDefault(key, at(s.settings, "notifications", "enabled")), (enabled) => ({ enabled }));
    case "notifications.ask_dismissed":
      return setting("notifications", (s) => orDefault(key, at(s.settings, "notifications", "dismissed")), (dismissed) => ({ dismissed }));
    case "list.rows":
      return setting("rows", (s) => (Array.isArray(s.settings.rows) ? (s.settings.rows as string[]) : [...INBOX_ROWS_DEFAULT]), (v) => v);
    case "list.mark_read_warning":
      return switchOf(key, "mark_read_warning");
    case "sidebar.hidden":
      return sidebar("hidden");
    case "sidebar.top":
      return sidebar("top");
    case "sidebar.bottom":
      return sidebar("bottom");
    case "reactions.saved":
      return setting("reactions", (s) => (Array.isArray(s.settings.reactions) ? (s.settings.reactions as { emoji: string; label?: string }[]) : []), (v) => v);
    case "decisions.post_to":
      return { route: "decisions", field: "post_to", read: (s) => (["description", "comment", "both"].includes(s.config.inboxDecisionsPostTo as string) ? (s.config.inboxDecisionsPostTo as string) : pref.default), write: (value) => ({ post_to: value }) };
    case "general.plannotator_localhost":
      return setting("cookie_host", (s) => (obj(s.settings.cookie_host) ? at(s.settings, "cookie_host", "on") === true : undefined), (v) => v);
    case "capabilities.board":
      return switchOf(key, "board");
    case "capabilities.checklist":
      return switchOf(key, "steps");
    case "capabilities.code_review":
      return heldSwitchOf("code_review");
    case "capabilities.shape":
      return heldSwitchOf("shape");
    case "capabilities.system":
      return heldSwitchOf("system");
    case "capabilities.chapter_diagrams":
      return heldSwitchOf("chapter_diagrams");
    case "experimental.decision_mode":
      return setting("experimental", (s) => orDefault(key, at(s.settings, "experimental", "decision_mode", "on")), (decision_mode) => ({ decision_mode }));
    case "experimental.bro":
      return switchOf(key, "bro");
    case "experimental.float_drafts":
      return switchOf(key, "float_drafts");
    case "updates.check":
      return setting("update_check", (s) => orDefault(key, at(s.settings, "updates", "update_check", "on")), (v) => v);
    case "updates.auto_install":
      return setting("auto_update", (s) => orDefault(key, at(s.settings, "updates", "auto_update", "on")), (v) => v);
    case "voice.on":
    case "voice.phones_only":
    case "voice.engine": {
      const field = name === "on" ? "on" : name === "phones_only" ? "phones_only" : "engine";
      return setting("voice", (s) => orDefault(key, at(s.settings, "voice", field)), (value) => ({ [field]: value }));
    }
    case "voice.api_key":
      return {
        route: "voice_key",
        field: "key",
        read: (s) => (at(s.settings, "voice", "key", "source") ? "set" : "not set"),
        write: (key) => ({ key }),
      };
    case "access.tailnet_window":
      return setting("tailscale", (s) => s.config.inboxTailscale === true, (on) => ({ on }));
    case "access.tailnet_allow":
      return { route: "tailscale_allow", field: "allow", read: (s) => resolveInboxTailscaleAllow(s.config), write: (allow) => ({ allow }) };
    case "access.this_wifi":
      return { route: "lan", field: "on", read: (s) => s.devices?.lan ?? undefined, write: (on) => ({ on }) };
    case "access.tailnet_door":
      return { route: "tailnet", field: "on", read: (s) => s.devices?.tailnet ?? undefined, write: (on) => ({ on }) };
  }
  throw new Error(`inbox-prefs: no route for ${key}`);
}

/** Deep merge of route bodies: objects merge per field, anything else is the later value. */
function mergeJson(a: Json, b: Json): Json {
  const out: Json = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const left = obj(out[key]);
    const right = obj(value);
    out[key] = left && right && key !== "sidebar" ? mergeJson(left, right) : value;
  }
  return out;
}

const BINDINGS: ReadonlyMap<string, Binding> = new Map(INBOX_PREFS.map((pref) => [pref.key, bindingOf(pref)]));

/** `cloud_agents.<id>.wake`: offered for a cloud agent whose preset wakes, as "set" or "not set". */
function cloudWakeBinding(key: string): Binding {
  const session = `cloud.${key.split(".")[1]}`;
  return {
    route: "cloud_wake",
    path: `/api/inbox/cloud-agents/${session}/wake`,
    field: "wake",
    read: (s) => {
      const row = s.cloud?.find((agent) => agent.session === session);
      if (!row || !inboxCloudPresetWakes(row.preset as InboxCloudPreset)) return undefined;
      return row.wake === true ? "set" : "not set";
    },
    write: (wake) => (wake === null ? { url: null, key: null } : (wake as Json)),
  };
}

const bindingFor = (pref: InboxPref): Binding => BINDINGS.get(pref.key) ?? cloudWakeBinding(pref.key);

/** The binding of every key, for the coverage test. */
export function inboxPrefBinding(key: string): { route: InboxPrefRoute; field: string; agent?: string } | null {
  const pref = inboxPref(key);
  const binding = pref ? bindingFor(pref) : undefined;
  return binding ? { route: binding.route, field: binding.field, ...(binding.agent ? { agent: binding.agent } : {}) } : null;
}

export interface InboxPrefEntry {
  key: string;
  group: string;
  label: string;
  meaning: string;
  where: string;
  scope: InboxPref["scope"];
  type: InboxPref["type"]["kind"];
  allowed: string;
  values?: readonly (string | number)[];
  min?: number;
  max?: number;
  default: InboxPrefValue;
  /** A secret's is "set" or "not set". */
  value: InboxPrefValue;
  secret?: true;
  next_start?: true;
}

/** GET /api/inbox/prefs: every key this caller is offered, with its value now; `group` keeps one group. */
export function inboxPrefsCatalogue(s: InboxPrefsSources, group: string | null): { groups: string[]; prefs: InboxPrefEntry[] } {
  const prefs: InboxPrefEntry[] = [];
  const cloud = (s.cloud ?? []).map((agent) => inboxCloudWakePref(String(agent.session).slice("cloud.".length), String(agent.name)));
  for (const pref of [...INBOX_PREFS, ...cloud]) {
    const binding = bindingFor(pref);
    if (group !== null && pref.group !== group) continue;
    const value = binding.read(s);
    if (value === undefined) continue;
    const type = pref.type;
    prefs.push({
      key: pref.key,
      group: pref.group,
      label: pref.label,
      meaning: pref.meaning,
      where: pref.where,
      scope: pref.scope,
      type: type.kind,
      allowed: inboxPrefAllowed(type),
      ...(type.kind === "choice" || type.kind === "list" ? { values: type.values } : {}),
      ...(type.kind === "number" ? (type.values ? { values: type.values } : { min: type.min, max: type.max }) : {}),
      ...(type.kind === "text" ? { max: type.max } : {}),
      default: pref.default,
      value,
      ...(pref.secret ? { secret: true as const } : {}),
      ...(pref.nextStart ? { next_start: true as const } : {}),
    });
  }
  return { groups: [...new Set(prefs.map((p) => p.group))], prefs };
}

export interface InboxPrefsDeps {
  read: (needs: ReturnType<typeof inboxPrefsNeeds>) => Promise<InboxPrefsSources>;
  /** One write through a window route, with the caller's headers. */
  dispatch: (path: string, body: Json) => Promise<{ status: number; body: Json | null }>;
}

export interface InboxPrefsAnswer {
  status: number;
  body: Json;
  /** The keys written, for `event: prefs` (the routes send it themselves; this is the answer's list). */
  saved: string[];
}

/**
 * POST /api/inbox/prefs `{ set?: { key: value }, reset?: [key] | "all", by?, serverSession? }`. Answers
 * `{ changes: [{ key, from, to }] }`, a change only where the value moved.
 */
export async function inboxPrefsPost(body: Json, deps: InboxPrefsDeps): Promise<InboxPrefsAnswer> {
  const refuse = (status: number, code: string, error: string, extra: Json = {}): InboxPrefsAnswer => ({ status, body: { error, code, ...extra }, saved: [] });
  const change = inboxPrefsChange(body);
  if (!change.ok) return refuse(change.status, change.code, change.error, change.key ? { key: change.key } : {});
  const before = await deps.read(inboxPrefsNeeds([...change.values.keys()].map((pref) => pref.key)));
  // `reset: "all"` puts back what this Inbox offers now; the rest (Code review off, no phones) is listed as skipped.
  const skipped: string[] = [];
  if (body.reset === "all") {
    const set = obj(body.set) ?? {};
    for (const pref of [...change.values.keys()]) {
      if (pref.key in set) continue;
      const now = bindingFor(pref).read(before);
      if (now === undefined) skipped.push(pref.key);
      // Already the default: nothing to write, so no route runs for it (the tailnet switch, launch, an agent's file).
      if (now === undefined || JSON.stringify(now) === JSON.stringify(pref.default)) change.values.delete(pref);
    }
  }
  const prefs = [...change.values.keys()];
  for (const pref of prefs) {
    const binding = bindingFor(pref);
    if (binding.read(before) === undefined) return refuse(409, "pref_unavailable", `${pref.key}: not offered on this Inbox now (${pref.where}).`, { key: pref.key });
  }
  // One body per route call: the settings route takes them all at once; an agents body names one agent; the
  // launch route takes one field a call.
  const calls = new Map<string, { route: InboxPrefRoute; path: string; body: Json; keys: string[] }>();
  for (const [pref, value] of change.values) {
    const binding = bindingFor(pref);
    const path = binding.path ?? INBOX_PREF_ROUTE_PATHS[binding.route as Exclude<InboxPrefRoute, "cloud_wake">];
    const id = binding.route === "agents" ? `agents:${binding.agent}` : binding.route === "launch" ? `launch:${binding.field}` : path;
    const call = calls.get(id) ?? { route: binding.route, path, body: {}, keys: [] };
    call.body = mergeJson(call.body, binding.write(value, before, call.body));
    call.keys.push(pref.key);
    calls.set(id, call);
  }
  const extra: Json = {};
  if (typeof body.serverSession === "string") extra.serverSession = body.serverSession;
  // Launch's own switch before its folder: the route refuses the folder while launch is off.
  const rank = (call: { route: InboxPrefRoute; body: Json }) => ROUTE_ORDER.indexOf(call.route) * 2 + (call.route === "launch" && call.body.enabled === undefined ? 1 : 0);
  const ordered = [...calls.values()].sort((a, b) => rank(a) - rank(b));
  const saved: string[] = [];
  for (const call of ordered) {
    const rowsBy = call.route === "settings" && call.body.rows !== undefined && body.by !== undefined ? { rows_by: body.by } : {};
    const answer = await deps.dispatch(call.path, { ...call.body, ...rowsBy, ...extra });
    // Settings → Agents says a switch that did not hold in `error` on a 200 (the agent not found, a file it cannot write).
    const agentProblem = call.route === "agents" && answer.status === 200 && typeof answer.body?.error === "string" ? answer.body.error : null;
    if (answer.status !== 200 || agentProblem) {
      const status = agentProblem ? 422 : answer.status;
      const refusal = agentProblem ? { error: `${call.keys.join(", ")}: ${agentProblem}`, code: "agent_not_changed" } : (answer.body ?? { error: `The Inbox answered ${answer.status}.`, code: "error" });
      // Not one write: the routes before this one keep what they saved (`saved`); `keys` are this route's, refused.
      return { status, body: { ...refusal, keys: call.keys, saved }, saved };
    }
    saved.push(...call.keys);
  }
  const after = await deps.read(inboxPrefsNeeds(saved));
  const changes = prefs.map((pref) => {
    const binding = bindingFor(pref);
    return { key: pref.key, from: binding.read(before) ?? null, to: binding.read(after) ?? null, secret: pref.secret === true };
  });
  // A secret written is a change even when it was set before: its value is never compared.
  const moved = changes.filter((c) => c.secret || JSON.stringify(c.from) !== JSON.stringify(c.to)).map(({ secret: _secret, ...c }) => c);
  return { status: 200, body: { changes: moved, ...(skipped.length > 0 ? { skipped } : {}) }, saved };
}

/** The keys a write through one of those routes touched: what `event: prefs` names. */
export function inboxPrefKeysOf(route: InboxPrefRoute, body: Json): string[] {
  const keys: string[] = [];
  for (const [key, binding] of BINDINGS) {
    if (binding.route !== route) continue;
    if (route === "agents" && body.agent !== binding.agent) continue;
    if (body[binding.field] !== undefined || (route === "settings" && binding.field === "diff_options" && body.diff_style !== undefined) || (route === "settings" && binding.field === "reactions" && body.reaction_change !== undefined) || (route === "settings" && binding.field === "rows" && body.rows_undo === true)) {
      keys.push(key);
    }
  }
  return keys;
}
