import { inboxRowsCanonical, type InboxRowsOption } from "./inbox-types";

export const INBOX_ROWS_ASK_OPEN = "<plannotator-rows-ask>";
export const INBOX_ROWS_ASK_CLOSE = "</plannotator-rows-ask>";

export const INBOX_ROWS_ASK_BLOCK = [
  INBOX_ROWS_ASK_OPEN,
  "The person asked this from Settings > Rows in the Inbox. They want the rows of their thread list to look different. Do only that.",
  "- First reply in this thread, in one line, that you are on it.",
  "- Run `plannotator inbox rows`. It prints every row option, what it changes and its value now.",
  "- Change the options that do what they asked, in one command: `plannotator inbox rows set <name>=<value> ...`. Change nothing else: no files, no config.json, no other setting.",
  "- If part of what they asked has no row option (a colour, a font, text size, a new column), say so and leave it. Do not work around it.",
  "- If two options would give clearly different lists and you can't tell which they mean, ask them, and change nothing until they answer.",
  "- Then reply here with what changed, in the words the command printed, and say that Undo is on the Rows page. If the command failed, quote its error and say that nothing changed.",
  INBOX_ROWS_ASK_CLOSE,
].join("\n");

type On = ReadonlySet<InboxRowsOption>;
type Change = Partial<Record<InboxRowsOption, boolean>>;

export interface InboxRowsSetting {
  name: string;
  label: string;
  values: readonly { value: string; label: string }[];
  changes: string;
  get: (on: On) => string | null;
  set: (value: string, on: On) => Change;
}

const ON_OFF = [
  { value: "on", label: "on" },
  { value: "off", label: "off" },
] as const;
const onSetting = (name: string, key: InboxRowsOption, label: string, changes: string): InboxRowsSetting => ({ name, label, values: ON_OFF, changes, get: (on) => (on.has(key) ? "on" : "off"), set: (value) => ({ [key]: value === "on" }) });
const showSetting = (name: string, key: InboxRowsOption, label: string, changes: string): InboxRowsSetting => ({ name, label, values: ON_OFF, changes, get: (on) => (on.has(key) ? "off" : "on"), set: (value) => ({ [key]: value !== "on" }) });
const badges = (on: On) => (on.has("marksThreads") ? (on.has("marksProjects") ? "both" : "threads") : on.has("marksProjects") ? "projects" : "off");

export const INBOX_ROWS_SETTINGS: readonly InboxRowsSetting[] = [
  {
    name: "spacing",
    label: "Spacing",
    values: [
      { value: "compact", label: "Compact" },
      { value: "comfortable", label: "Comfortable" },
      { value: "roomy", label: "Roomy" },
    ],
    changes: "Room around each row. compact: project and name share the first line.",
    get: (on) => (on.has("compact") ? "compact" : on.has("roomy") ? "roomy" : "comfortable"),
    set: (value) => ({ compact: value === "compact", roomy: value === "roomy" }),
  },
  {
    name: "grey-line",
    label: "Grey line under the name",
    values: [
      { value: "none", label: "None" },
      { value: "1", label: "1 line" },
      { value: "2", label: "2 lines" },
    ],
    changes: "Lines of the latest message under a thread's name.",
    get: (on) => (on.has("hidePreview") ? "none" : on.has("previewTwo") ? "2" : "1"),
    set: (value) => ({ hidePreview: value === "none", previewTwo: value === "2" }),
  },
  {
    name: "first",
    label: "First on the row",
    values: [
      { value: "project", label: "Project" },
      { value: "name", label: "Thread name" },
    ],
    changes: "What the row starts with.",
    get: (on) => (on.has("titleFirst") ? "name" : "project"),
    set: (value) => ({ titleFirst: value === "name" }),
  },
  {
    name: "time",
    label: "Time",
    values: [
      { value: "clock", label: "9:12 PM" },
      { value: "ago", label: "10m ago" },
    ],
    changes: "9:12 PM, or 10m.",
    get: (on) => (on.has("relativeTime") ? "ago" : "clock"),
    set: (value) => ({ relativeTime: value === "ago" }),
  },
  {
    name: "needs-you",
    label: "When a thread needs you",
    values: [
      { value: "count", label: "Question count" },
      { value: "mark", label: "One mark" },
    ],
    changes: "The question count, or one mark, when a thread needs the person.",
    get: (on) => (on.has("statusMark") ? "mark" : "count"),
    set: (value) => ({ statusMark: value === "mark" }),
  },
  showSetting("agent-icons", "hideAgents", "Agent icons", "The agents' icons on each row."),
  showSetting("project-name", "hideProject", "Project name", "The project's name on each row."),
  showSetting("pull-requests", "hidePulls", "Pull requests", "A pull request's state at the end of the row."),
  {
    name: "new-threads",
    label: "New threads",
    values: [
      { value: "bigger", label: "Bigger name" },
      { value: "bold", label: "Bold name" },
      { value: "dot", label: "Dot" },
    ],
    changes: "How an unread thread stands out.",
    get: (on) => (on.has("unreadDot") ? "dot" : on.has("smallNames") ? "bold" : "bigger"),
    set: (value) => ({ smallNames: value !== "bigger", unreadDot: value === "dot" }),
  },
  onSetting("bold-names", "boldNames", "Every thread name in bold", "Every thread name in bold, read ones too."),
  onSetting("name-pill", "highlight", "Thread name in a grey pill", "The thread name in a grey pill."),
  onSetting("row-lines", "dividers", "Lines between rows", "A line between rows."),
  {
    name: "time-place",
    label: "Where the time sits",
    values: [
      { value: "top", label: "Top right" },
      { value: "under", label: "Under the row" },
    ],
    changes: "The time at the top right, or under the row. Not on compact rows.",
    get: (on) => (on.has("timeBelow") ? "under" : "top"),
    set: (value) => ({ timeBelow: value === "under" }),
  },
  {
    name: "letter-badges",
    label: "Letter badges",
    values: [
      { value: "off", label: "Off" },
      { value: "threads", label: "Threads" },
      { value: "projects", label: "Projects" },
      { value: "both", label: "Both" },
    ],
    changes: "Coloured letter badges.",
    get: badges,
    set: (value) => ({ marksThreads: value === "threads" || value === "both", marksProjects: value === "projects" || value === "both" }),
  },
  {
    name: "badge-shape",
    label: "Badge shape",
    values: [
      { value: "big", label: "Big, at the left" },
      { value: "small", label: "Small, in the line" },
      { value: "dot", label: "A dot" },
    ],
    changes: "The badge: big at the left, small in the line, or a dot. Picking one turns thread badges on.",
    get: (on) => (badges(on) === "off" ? null : on.has("markInline") ? "small" : on.has("markDot") ? "dot" : "big"),
    set: (value, on) => ({ markInline: value === "small", markDot: value === "dot", ...(badges(on) === "off" ? { marksThreads: true } : {}) }),
  },
  onSetting("repo-logo", "repoLogo", "Repo logo on project badges", "The repo's logo on project badges. Turns project badges on."),
  onSetting("github-pictures", "githubPictures", "GitHub pictures on project badges", "The GitHub owner's picture on project badges. Turns project badges on."),
];

export const INBOX_ROWS_LOOKS: readonly { value: string; label: string; rows: readonly InboxRowsOption[] }[] = [
  { value: "balanced", label: "Balanced", rows: ["smallNames"] },
  { value: "dense", label: "Dense", rows: ["compact", "smallNames", "relativeTime", "dividers", "statusMark"] },
  { value: "minimal", label: "Minimal", rows: ["smallNames", "hidePreview", "titleFirst"] },
  { value: "detailed", label: "Detailed", rows: ["roomy", "previewTwo", "marksThreads", "marksProjects", "repoLogo"] },
];
export const INBOX_ROWS_LOOK_NAME = "look";
const LOOK_CHANGES = "A whole look: sets every option above at once.";

export function inboxRowsWithChange(rows: readonly InboxRowsOption[], change: Change): InboxRowsOption[] {
  const on = new Set(rows);
  for (const [key, value] of Object.entries(change) as [InboxRowsOption, boolean][]) {
    if (value) on.add(key);
    else on.delete(key);
  }
  if (change.compact) on.delete("roomy");
  if (change.roomy) on.delete("compact");
  if (change.hidePreview) on.delete("previewTwo");
  if (change.previewTwo) on.delete("hidePreview");
  if (change.unreadDot) on.add("smallNames");
  if (change.smallNames === false) on.delete("unreadDot");
  if (change.markInline) on.delete("markDot");
  if (change.markDot) on.delete("markInline");
  if (change.repoLogo || change.githubPictures) on.add("marksProjects");
  return inboxRowsCanonical([...on]);
}

export function inboxRowsLookOf(rows: readonly InboxRowsOption[]): string | null {
  const key = inboxRowsCanonical(rows).join();
  return INBOX_ROWS_LOOKS.find((look) => inboxRowsCanonical(look.rows).join() === key)?.value ?? null;
}

const quoted = (values: readonly { value: string }[]) => {
  const names = values.map((entry) => entry.value);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : (names[0] ?? "");
};

export function inboxRowsApply(rows: readonly InboxRowsOption[], pairs: readonly string[]): { rows: InboxRowsOption[] } | { error: string } {
  const seen = new Set<string>();
  const parsed: { name: string; value: string }[] = [];
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    const name = at > 0 ? pair.slice(0, at) : pair;
    const value = at > 0 ? pair.slice(at + 1) : "";
    const setting = name === INBOX_ROWS_LOOK_NAME ? { values: INBOX_ROWS_LOOKS } : INBOX_ROWS_SETTINGS.find((entry) => entry.name === name);
    if (!setting) return { error: INBOX_ROWS_WORDS.unknownName(name) };
    if (!setting.values.some((entry) => entry.value === value)) return { error: INBOX_ROWS_WORDS.badValue(name, quoted(setting.values), value) };
    if (seen.has(name)) return { error: INBOX_ROWS_WORDS.twice(name) };
    seen.add(name);
    parsed.push({ name, value });
  }
  const look = parsed.find((pair) => pair.name === INBOX_ROWS_LOOK_NAME);
  let next = look ? inboxRowsCanonical(INBOX_ROWS_LOOKS.find((entry) => entry.value === look.value)!.rows) : inboxRowsCanonical(rows);
  for (const pair of parsed) {
    if (pair.name === INBOX_ROWS_LOOK_NAME) continue;
    const setting = INBOX_ROWS_SETTINGS.find((entry) => entry.name === pair.name)!;
    next = inboxRowsWithChange(next, setting.set(pair.value, new Set(next)));
  }
  return { rows: next };
}

const wordOf = (setting: InboxRowsSetting, on: On) => {
  const value = setting.get(on);
  return setting.values.find((entry) => entry.value === value)?.label ?? "off";
};

export function inboxRowsChangeLines(before: readonly InboxRowsOption[], after: readonly InboxRowsOption[]): string[] {
  const was = new Set(inboxRowsCanonical(before));
  const now = new Set(inboxRowsCanonical(after));
  return INBOX_ROWS_SETTINGS.filter((setting) => setting.get(was) !== setting.get(now)).map((setting) => `${setting.label}: ${wordOf(setting, was)} -> ${wordOf(setting, now)}`);
}

export const INBOX_ROWS_WORDS = {
  listHead: "Your Inbox rows now. Change them with: plannotator inbox rows set <name>=<value> ...",
  listFoot: "Not row options: text size and theme (Settings > General), colours, fonts, columns, sorting.",
  changedHead: "Changed your Inbox rows:",
  changedFoot: "Every open Inbox window shows it now, with Undo. To undo from here: plannotator inbox rows undo",
  nothingChanged: "Nothing changed: the rows already look like that.",
  undoneHead: "Put your Inbox rows back:",
  nothingToUndo: "Nothing to undo.",
  unknownName: (name: string) => `'${name}' is not a row option. Run 'plannotator inbox rows' for the names. Nothing changed.`,
  badValue: (name: string, values: string, given: string) => `${name} takes ${values}, not '${given}'. Nothing changed.`,
  twice: (name: string) => `'${name}' is given twice. Nothing changed.`,
  setNeedsPairs: "inbox rows set needs at least one <name>=<value>.",
} as const;

export function inboxRowsListing(rows: readonly InboxRowsOption[]): string {
  const on = new Set(inboxRowsCanonical(rows));
  const line = (name: string, value: string, values: readonly { value: string }[], changes: string) => `${`${name}=${value}`.padEnd(24)} ${values.map((entry) => entry.value).join(" | ").padEnd(35)} ${changes}`;
  return [
    INBOX_ROWS_WORDS.listHead,
    "",
    ...INBOX_ROWS_SETTINGS.map((setting) => line(setting.name, setting.get(on) ?? "none", setting.values, setting.changes)),
    "",
    line(INBOX_ROWS_LOOK_NAME, inboxRowsLookOf(rows) ?? "none", INBOX_ROWS_LOOKS, LOOK_CHANGES),
    "",
    INBOX_ROWS_WORDS.listFoot,
    "",
  ].join("\n");
}

export function inboxRowsListingJson(rows: readonly InboxRowsOption[]) {
  const on = new Set(inboxRowsCanonical(rows));
  return {
    options: INBOX_ROWS_SETTINGS.map((setting) => ({ name: setting.name, value: setting.get(on), values: setting.values.map((entry) => entry.value), changes: setting.changes })),
    look: inboxRowsLookOf(rows),
  };
}

export const INBOX_ROWS_USAGE = [
  "Usage:",
  "  plannotator inbox rows [--json]",
  "  plannotator inbox rows set <name>=<value> ... [--json]",
  "  plannotator inbox rows undo [--json]",
  "",
  "Shows and changes how the rows of the person's Inbox list look.",
  "'rows' prints every option, what it changes and its value now.",
  "'rows set' changes options in one save; every open window shows it at once.",
  "'rows undo' puts the last change back.",
  "It changes row options only: no other setting.",
].join("\n");

export const INBOX_ROWS_USAGE_LINE = "  plannotator inbox rows [set <name>=<value>... | undo] [--json]";

export const INBOX_ROWS_HELP_SECTION = [
  "## When the person asks you to change how their Inbox list looks",
  "",
  "Run `plannotator inbox rows`: it prints every row option, what it changes and its value now. Change what they asked with `plannotator inbox rows set <name>=<value> ...`; every open window shows it at once. `plannotator inbox rows undo` puts the last change back. Tell them what changed, in the words the command printed. An ask with no row option (a colour, a font, text size) stays as it is: say so.",
];

export interface InboxRowsBy {
  host: string;
  session: string;
}

export function inboxRowsBy(value: unknown): InboxRowsBy | null {
  if (!value || typeof value !== "object") return null;
  const { host, session } = value as Record<string, unknown>;
  if (typeof host !== "string" || typeof session !== "string" || !host || !session || host.length > 64 || session.length > 200) return null;
  return { host, session };
}
