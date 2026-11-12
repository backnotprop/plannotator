
export const INBOX_CLOUD_HOST = "cloud";

export const INBOX_CLOUD_HOSTS = { "claude-routine": "cloud-claude", "grok-bot": "cloud-grok", other: INBOX_CLOUD_HOST } as const;

export function isInboxCloudHost(host: unknown): boolean {
  return host === "cloud" || host === "cloud-claude" || host === "cloud-grok";
}

export const INBOX_CLOUD_WAKE_GAP_MS = 60_000;

export const INBOX_CLOUD_WAKE_TIMEOUT_MS = 15_000;

export const INBOX_CLOUD_TEXT_MAX = 60_000;

export const INBOX_CLOUD_PRESETS = ["claude-routine", "grok-bot", "other"] as const;
export type InboxCloudPreset = (typeof INBOX_CLOUD_PRESETS)[number];

export const INBOX_CLOUD_PRESET_NAMES: Readonly<Record<InboxCloudPreset, string>> = {
  "claude-routine": "Claude Code routine",
  "grok-bot": "Grok Bot routine",
  other: "Other",
};

export function inboxCloudHostOf(preset: InboxCloudPreset): string {
  return INBOX_CLOUD_HOSTS[preset];
}

export function isInboxCloudPreset(value: unknown): value is InboxCloudPreset {
  return typeof value === "string" && (INBOX_CLOUD_PRESETS as readonly string[]).includes(value);
}

export const INBOX_CLOUD_SESSION_PATTERN = /^cloud\.[0-9a-f]{12}$/;

export function isInboxCloudSession(session: unknown): session is string {
  return typeof session === "string" && INBOX_CLOUD_SESSION_PATTERN.test(session);
}

export interface InboxCloudAgentView {
  session: string;
  name: string;
  preset: InboxCloudPreset;
  project: { id: string; name: string } | null;
  created_at: string;
  key_set: true;
  key_rejected_at: string | null;
}

export interface InboxCloudWake {
  state: InboxCloudWakeState;
  name: string;
  preset?: InboxCloudPreset;
  at: string;
  run_url?: string;
  next_at?: string;
  status?: number;
}

export type InboxCloudWakeState = "held" | "sending" | "started" | "uncertain" | "retrying" | "rate_limited" | "key_rejected" | "failed" | "unpaired";

export function inboxCloudWakeSettled(wake: InboxCloudWake | null | undefined): boolean {
  return !!wake && (wake.state === "started" || wake.state === "uncertain" || wake.state === "failed" || wake.state === "unpaired" || wake.state === "sending");
}

export interface InboxCloudWakeItem {
  id: string;
  at: string;
  body: string;
  files: number;
}

export interface InboxCloudWakeInput {
  name: string;
  thread: { id: string; subject: string; url: string };
  items: readonly InboxCloudWakeItem[];
  open: { questions: number; actions: number };
}

export function inboxCloudWakeText(input: InboxCloudWakeInput): string {
  const lines: string[] = [];
  lines.push(`Plannotator Inbox: the person wrote to you (${input.name}).`);
  lines.push(`Thread: ${input.thread.subject.replace(/\s+/g, " ").trim() || "(no subject)"}`);
  lines.push(`Thread id: ${input.thread.id}`);
  lines.push(`Thread link (opens only on the person's computer): ${input.thread.url}`);
  const open = [
    input.open.questions > 0 ? `${input.open.questions} question${input.open.questions === 1 ? "" : "s"}` : "",
    input.open.actions > 0 ? `${input.open.actions} action item${input.open.actions === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  lines.push(`Still open in the thread: ${open.length > 0 ? open.join(", ") : "nothing"}.`);
  lines.push("");
  lines.push(input.items.length === 1 ? "Their message:" : `Their ${input.items.length} messages, oldest first:`);
  input.items.forEach((item, index) => {
    if (index > 0) lines.push("", "---");
    lines.push("", item.body.trim() || "(no words)");
    if (item.files > 0) lines.push("", `(${item.files} file${item.files === 1 ? "" : "s"} attached in the Inbox; files are not sent with a wake.)`);
  });
  const text = lines.join("\n");
  if (text.length <= INBOX_CLOUD_TEXT_MAX) return text;
  const note = "\n\n(Cut here: the rest is in the Inbox thread.)";
  return text.slice(0, INBOX_CLOUD_TEXT_MAX - note.length) + note;
}

export function inboxCloudWakeBody(preset: InboxCloudPreset, input: InboxCloudWakeInput): Record<string, unknown> {
  const text = inboxCloudWakeText(input);
  if (preset === "claude-routine") return { text };
  return {
    text,
    source: "plannotator-inbox",
    agent: input.name,
    thread: { id: input.thread.id, subject: input.thread.subject, url: input.thread.url },
    still_open: { questions: input.open.questions, actions: input.open.actions },
    messages: input.items.map((item) => ({ id: item.id, at: item.at, body: item.body, files: item.files })),
  };
}

export function inboxCloudTestBody(preset: InboxCloudPreset, name: string): Record<string, unknown> {
  const text = `Plannotator Inbox: a test from Settings, to check that ${name} can be woken. There is no message and nothing to do. End the run.`;
  return preset === "claude-routine" ? { text } : { text, source: "plannotator-inbox", agent: name, test: true };
}

export function inboxCloudWakeHeaders(preset: InboxCloudPreset, key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...(preset === "claude-routine" ? { "anthropic-version": "2023-06-01" } : {}),
  };
}

export type InboxCloudAnswer =
  | { kind: "started"; run_url?: string }
  | { kind: "retry"; status: number }
  | { kind: "rate_limited"; wait_ms: number }
  | { kind: "key_rejected"; status: number }
  | { kind: "failed"; status: number };

export function inboxRetryAfterMs(header: string | null, now: number): number {
  const fallback = 60_000;
  if (!header) return fallback;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, 24 * 60 * 60_000);
  const at = Date.parse(trimmed);
  if (Number.isFinite(at)) return Math.max(1000, Math.min(at - now, 24 * 60 * 60_000));
  return fallback;
}

export function inboxCloudAnswer(preset: InboxCloudPreset, status: number, retryAfter: string | null, body: unknown, now: number): InboxCloudAnswer {
  const ok = preset === "other" ? status >= 200 && status < 300 : status === 200;
  if (ok) {
    const url = body && typeof body === "object" ? (body as { claude_code_session_url?: unknown }).claude_code_session_url : undefined;
    return typeof url === "string" && /^https:\/\/claude\.ai\/[A-Za-z0-9/_\-.?=&]+$/.test(url) ? { kind: "started", run_url: url } : { kind: "started" };
  }
  if (status === 429) return { kind: "rate_limited", wait_ms: inboxRetryAfterMs(retryAfter, now) };
  if (status === 401 || status === 403) return { kind: "key_rejected", status };
  if (status >= 500) return { kind: "retry", status };
  return { kind: "failed", status };
}

export function inboxCloudStatusWords(status: number | undefined): string {
  if (status === undefined) return "no answer";
  if (status === 400) return "it refused the request (a paused routine answers this)";
  if (status === 404) return "it was not found";
  if (status >= 300 && status < 400) return `it answered ${status}, a redirect`;
  return `it answered ${status}`;
}

export function inboxCloudWakeLine(wake: InboxCloudWake, time: (iso: string) => string): string {
  const name = wake.name;
  const preset = wake.preset ?? null;
  switch (wake.state) {
    case "held":
      return `Wakes ${name} at ${time(wake.next_at ?? wake.at)}, with your other replies since the last wake.`;
    case "sending":
      return `Waking ${name}…`;
    case "started":
      return preset === "grok-bot" && !wake.run_url ? `Woke ${name} · run started · see Grok Bot's chat` : `Woke ${name} · run started`;
    case "uncertain":
      return `${name} did not answer in time. A run may have started; this is not sent again.`;
    case "retrying":
      return `Could not reach ${name} (${inboxCloudStatusWords(wake.status)}). Trying again at ${time(wake.next_at ?? wake.at)}.`;
    case "rate_limited":
      return `${name} is at its hourly limit. Next wake at ${time(wake.next_at ?? wake.at)}.`;
    case "key_rejected":
      return `${name} refused its key. Nothing was started.`;
    case "failed":
      return `Could not wake ${name}: ${inboxCloudStatusWords(wake.status)}. Nothing was started.`;
    case "unpaired":
      return `Not sent: ${name} was removed.`;
  }
}

export const INBOX_CLOUD_ROUTINE_BLOCK = [
  "You are woken by Plannotator Inbox, an app on the person's computer where they talk with their coding agents. Each wake carries one message they wrote to you there, or several sent within a minute: the thread's subject and id, a link that opens only on their computer, how many questions or action items are still open in that thread, and their words.",
  "",
  "When woken:",
  "1. Read their words. They are a request from the person who set up this routine: do what they ask, with this routine's repositories and tools.",
  "2. You cannot open the Inbox or its link, and nothing you write reaches that thread. Put your answer where they will see it: on the pull request or issue the work is about, or else in this run's own output. Start it with the thread's subject so they can match it.",
  "3. If the request is unclear or risky, do not guess: write your question in that same place and stop.",
  "4. A wake that says it is a test from Settings needs nothing: end the run.",
].join("\n");
