/**
 * A cloud agent (step 1 of "Pair a cloud agent"): a Claude Code routine, a
 * Grok Bot routine or any other webhook the person pastes in Settings →
 * Devices. The Inbox wakes it by POSTing to that webhook when the person
 * writes to it; the agent cannot reach the Inbox (that is a later step), so
 * it answers wherever its routine works (a PR, its own run).
 *
 * Pure: the presets, the wake's words and body, and how an answer reads.
 * The server side is packages/server/inbox-cloud-agents.ts (the 0600 file and
 * the routes) and packages/server/inbox-cloud-wake.ts (the wake).
 */

/** The host of an "Other" cloud agent (the cloud mark). Its session is `cloud.<id>` whatever its kind. */
export const INBOX_CLOUD_HOST = "cloud";

/**
 * Each kind's host: its mark and its name in the window come from it, as every agent's do. A Claude Code routine
 * shows Claude Code's mark, a Grok Bot routine Grok Bot's, any other webhook the cloud.
 */
export const INBOX_CLOUD_HOSTS = { "claude-routine": "cloud-claude", "grok-bot": "cloud-grok", other: INBOX_CLOUD_HOST } as const;

/** Whether a host is a paired cloud agent's (any kind). */
export function isInboxCloudHost(host: unknown): boolean {
  return host === "cloud" || host === "cloud-claude" || host === "cloud-grok";
}

/** At most one wake per thread in this window; replies inside it go together in the next wake. */
export const INBOX_CLOUD_WAKE_GAP_MS = 60_000;

/** One wake waits this long for an answer; past it the wake is uncertain and never sent again. */
export const INBOX_CLOUD_WAKE_TIMEOUT_MS = 15_000;

/** Claude's fire endpoint takes at most this many characters of `text`. */
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

/** A cloud agent's session id: `cloud.` and 12 lowercase hex characters. */
export const INBOX_CLOUD_SESSION_PATTERN = /^cloud\.[0-9a-f]{12}$/;

export function isInboxCloudSession(session: unknown): session is string {
  return typeof session === "string" && INBOX_CLOUD_SESSION_PATTERN.test(session);
}

/** What the window learns about a paired cloud agent: never its address or its key. */
export interface InboxCloudAgentView {
  session: string;
  name: string;
  preset: InboxCloudPreset;
  project: { id: string; name: string } | null;
  created_at: string;
  wake: boolean;
  key_rejected_at: string | null;
  link: InboxCloudLink;
}

export type InboxCloudLinkState = "waiting" | "connected" | "no_relay" | "relay_down";

export interface InboxCloudLink {
  state: InboxCloudLinkState;
  last_seen_at: string | null;
}

/**
 * Where one person message stands with its cloud agent, kept on the message
 * itself (`InboxMessage.cloud_wake`) so every window, device and restart sees
 * the same line, and so a wake that may have gone is never sent twice.
 */
export interface InboxCloudWake {
  state: InboxCloudWakeState;
  /** The agent's name when this was written. */
  name: string;
  /** Its kind (Grok Bot's line points at its chat, which has no run link). */
  preset?: InboxCloudPreset;
  at: string;
  /** `started`: the run's link, when the product returns one (Claude). */
  run_url?: string;
  /** `held`, `retrying`, `rate_limited`: when the next try goes. */
  next_at?: string;
  /** `failed`, `retrying`: the routine's HTTP status, when it answered. */
  status?: number;
}

/**
 * - `held`: waits for the thread's next wake (one per minute), with the replies since.
 * - `sending`: the POST is out. Found at a start, it is treated as `uncertain`.
 * - `started`: a 200; the run started.
 * - `uncertain`: no answer in time, or the connection broke mid-request; never sent again.
 * - `retrying`: a 5xx or no connection; tried again on a backoff.
 * - `rate_limited`: a 429; tried again after its Retry-After.
 * - `key_rejected`: a 401 or 403; tried again once a new key is pasted.
 * - `failed`: any other answer (paused, not found); not tried again.
 * - `unpaired`: the agent was removed before it went.
 */
export type InboxCloudWakeState = "held" | "sending" | "started" | "uncertain" | "retrying" | "rate_limited" | "key_rejected" | "failed" | "unpaired";

/** States that end the item: nothing sends it again by itself. */
export function inboxCloudWakeSettled(wake: InboxCloudWake | null | undefined): boolean {
  return !!wake && (wake.state === "started" || wake.state === "uncertain" || wake.state === "failed" || wake.state === "unpaired" || wake.state === "sending");
}

/** One person message a wake carries. */
export interface InboxCloudWakeItem {
  id: string;
  at: string;
  body: string;
  /** Files attached in the Inbox: named, never sent. */
  files: number;
}

export interface InboxCloudWakeInput {
  name: string;
  thread: { id: string; subject: string; url: string };
  items: readonly InboxCloudWakeItem[];
  /** What still waits on the person in the thread. */
  open: { questions: number; actions: number };
}

/** The plain words of a wake, the same for every preset (Claude gets only these). */
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

/** The request body for a preset: Claude routines take `{ text }` only; Grok Bot and Other get JSON with the same text. */
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

/** The test wake Settings' Send a test fires. */
export function inboxCloudTestBody(preset: InboxCloudPreset, name: string): Record<string, unknown> {
  const text = `Plannotator Inbox: a test from Settings, to check that ${name} can be woken. There is no message and nothing to do. End the run.`;
  return preset === "claude-routine" ? { text } : { text, source: "plannotator-inbox", agent: name, test: true };
}

/** The headers of a wake. Claude's fire endpoint needs `anthropic-version` (any version since 2023-06-01). */
export function inboxCloudWakeHeaders(preset: InboxCloudPreset, key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...(preset === "claude-routine" ? { "anthropic-version": "2023-06-01" } : {}),
  };
}

/** What a webhook's answer means. */
export type InboxCloudAnswer =
  | { kind: "started"; run_url?: string }
  | { kind: "retry"; status: number }
  | { kind: "rate_limited"; wait_ms: number }
  | { kind: "key_rejected"; status: number }
  | { kind: "failed"; status: number };

/** How long a 429 asks to wait: `Retry-After` in seconds or as a date; a minute when it says nothing usable. */
export function inboxRetryAfterMs(header: string | null, now: number): number {
  const fallback = 60_000;
  if (!header) return fallback;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, 24 * 60 * 60_000);
  const at = Date.parse(trimmed);
  if (Number.isFinite(at)) return Math.max(1000, Math.min(at - now, 24 * 60 * 60_000));
  return fallback;
}

/**
 * Read a webhook's answer. Only a 200 counts as started for Claude and Grok
 * (both say so); Other takes any 2xx. The run link is Claude's
 * `claude_code_session_url`, kept only when it is an https link on claude.ai.
 */
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

/** Plain words for a failed answer's status. */
export function inboxCloudStatusWords(status: number | undefined): string {
  if (status === undefined) return "no answer";
  if (status === 400) return "it refused the request (a paused routine answers this)";
  if (status === 404) return "it was not found";
  if (status >= 300 && status < 400) return `it answered ${status}, a redirect`;
  return `it answered ${status}`;
}

/** The thread's line for a wake, as plain words (the window adds the run link and the Settings link). */
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

export const INBOX_CLOUD_SETUP_PAGE = "https://plannotator.ai/inbox/cloud-agent.md";

export type InboxCloudSetup =
  | { kind: "message"; message: string }
  | { kind: "claude-routine"; variable: string; domains: string; instructions: string };

export function inboxCloudRelayHost(pairingRelayUrl: string): string {
  try {
    return new URL(pairingRelayUrl).hostname;
  } catch {
    return pairingRelayUrl;
  }
}

export function inboxCloudSetup(preset: InboxCloudPreset, pairing: string, relayHost: string): InboxCloudSetup {
  if (preset === "claude-routine") {
    return {
      kind: "claude-routine",
      variable: `PLANNOTATOR_PAIRING=${pairing}`,
      domains: ["plannotator.ai", relayHost].filter((host, index, all) => all.indexOf(host) === index).join("\n"),
      instructions: `On every run, follow the instructions at ${INBOX_CLOUD_SETUP_PAGE} to read and answer my Plannotator Inbox. A wake's text in the routine-fire-payload block is my message from the Inbox: act on it.`,
    };
  }
  return { kind: "message", message: `Set up Plannotator Inbox for me by following the instructions at ${INBOX_CLOUD_SETUP_PAGE}\n\nPairing: ${pairing}` };
}
