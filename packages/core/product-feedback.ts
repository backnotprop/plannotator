export const PRODUCT_FEEDBACK_URL = "https://plannotator-feedback.plannotator.workers.dev/feedback";
/** Overrides PRODUCT_FEEDBACK_URL (an http or https URL). Tests point it at a local server. */
export const PRODUCT_FEEDBACK_URL_ENV = "PLANNOTATOR_FEEDBACK_URL";

export const FEEDBACK_MESSAGE_MAX = 4000;
export const FEEDBACK_CONTACT_MAX = 200;
export const FEEDBACK_CATEGORIES = ["bug", "idea", "other"] as const;
export const FEEDBACK_SURFACES = ["inbox", "plan-review", "code-review", "annotate", "cli"] as const;
/** At most this many agent names ride one submission. */
export const FEEDBACK_AGENTS_MAX = 8;
/** Each agent name is a short label of at most this many characters. */
export const FEEDBACK_AGENT_NAME_MAX = 40;

export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];
export type FeedbackSurface = (typeof FEEDBACK_SURFACES)[number];

/** What a person typed (the message, and optionally a category and a way to reach them). */
export interface ProductFeedbackInput {
  message: string;
  category?: FeedbackCategory | null;
  contact?: string | null;
}

/** The wire body: the input plus the version, the OS, the surface and the agent names. Exactly these keys. */
export interface ProductFeedbackPayload {
  message: string;
  category?: FeedbackCategory;
  contact?: string;
  version: string;
  os: string;
  surface: FeedbackSurface;
  agents?: string[];
}

export const FEEDBACK_UNAVAILABLE = "Couldn't send feedback right now; nothing was saved.";

/**
 * The end word of the quoted heredoc that carries the message to `plannotator feedback --stdin` in
 * the copied prompt, the CLI help, the skill and the README.
 */
export const FEEDBACK_HEREDOC_END = "PLANNOTATOR_FEEDBACK_END";

/**
 * How long a send waits for the Worker, in all: the resend without agent names
 * (`sendProductFeedback`) included.
 */
export const FEEDBACK_TIMEOUT_MS = 8_000;

/**
 * The resend without agent names goes only when this much of the deadline is left: with less, a slow
 * Worker could store it after the wait gave up and the person would read "nothing was saved".
 */
export const FEEDBACK_RESEND_MIN_MS = 1_000;

/** `unavailable`: the service could not take it (reason is FEEDBACK_UNAVAILABLE); otherwise the Worker refused it and `reason` is its words. */
export type ProductFeedbackResult = { ok: true } | { ok: false; reason: string; status?: number; unavailable: boolean };

/** The URL to send to: a valid http(s) override from the env, else the constant. */
export function productFeedbackUrl(env: Record<string, string | undefined> = {}): string {
  const override = env[PRODUCT_FEEDBACK_URL_ENV]?.trim();
  if (override) {
    try {
      const url = new URL(override);
      if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
    } catch {
    }
  }
  return PRODUCT_FEEDBACK_URL;
}

/** A plain OS name from `process.platform` (or `navigator`'s platform string): macOS, Windows, Linux, else the raw word. */
export function feedbackOsName(platform: string): string {
  const p = platform.toLowerCase();
  if (p === "darwin" || p.startsWith("mac")) return "macOS";
  if (p === "win32" || p.startsWith("win")) return "Windows";
  if (p === "linux" || p.startsWith("linux")) return "Linux";
  if (p === "freebsd" || p === "openbsd" || p === "android" || p === "ios") return p;
  return "other";
}

function lengthOf(value: string): number {
  let n = 0;
  for (const _ of value) n += 1;
  return n;
}

/** Checks a person's input the way the Worker will: an error to show, or null. */
export function feedbackInputError(input: ProductFeedbackInput): string | null {
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!message) return "Write your feedback first.";
  if (lengthOf(message) > FEEDBACK_MESSAGE_MAX) return `Keep it under ${FEEDBACK_MESSAGE_MAX.toLocaleString("en-US")} characters.`;
  if (input.category != null && !(FEEDBACK_CATEGORIES as readonly string[]).includes(input.category)) {
    return `Category must be one of: ${FEEDBACK_CATEGORIES.join(", ")}.`;
  }
  const contact = typeof input.contact === "string" ? input.contact.trim() : "";
  if (lengthOf(contact) > FEEDBACK_CONTACT_MAX) return `Keep the contact under ${FEEDBACK_CONTACT_MAX} characters.`;
  return null;
}

const AGENT_NAME_RE = /^[0-9A-Za-z][0-9A-Za-z+_()-]*(?:(?: | \/ )[0-9A-Za-z+_()-]+)*$/;

export function feedbackAgentNames(names: Iterable<unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    if (out.length >= FEEDBACK_AGENTS_MAX) break;
    if (typeof raw !== "string") continue;
    const name = raw.trim().replace(/\s+/g, " ");
    if (!name || lengthOf(name) > FEEDBACK_AGENT_NAME_MAX || !AGENT_NAME_RE.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** The exact body sent: the input's words, the version, the OS, the surface and the agent names, if any. */
export function productFeedbackPayload(
  input: ProductFeedbackInput,
  meta: { version: string; os: string; surface: FeedbackSurface; agents?: Iterable<unknown> },
): ProductFeedbackPayload {
  const contact = typeof input.contact === "string" ? input.contact.trim() : "";
  const agents = feedbackAgentNames(meta.agents ?? []);
  return {
    message: input.message.trim(),
    ...(input.category ? { category: input.category } : {}),
    ...(contact ? { contact } : {}),
    version: meta.version.slice(0, 40),
    os: meta.os.slice(0, 40),
    surface: meta.surface,
    ...(agents.length > 0 ? { agents } : {}),
  };
}

function refusedAgentsField(status: number, error: unknown): boolean {
  return status === 400 && typeof error === "string" && error.startsWith("Unknown field: agents");
}

export interface SendProductFeedbackOptions {
  url: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** POSTs one submission. No cookies, no credentials, no redirects; the answer's body is never read beyond its error. */
export async function sendProductFeedback(payload: ProductFeedbackPayload, options: SendProductFeedbackOptions): Promise<ProductFeedbackResult> {
  const deadline = Date.now() + (options.timeoutMs ?? FEEDBACK_TIMEOUT_MS);
  const result = await sendOnce(payload, options);
  if ("reason" in result && payload.agents && refusedAgentsField(result.status ?? 0, result.reason)) {
    const left = deadline - Date.now();
    if (left < FEEDBACK_RESEND_MIN_MS) return { ok: false, reason: FEEDBACK_UNAVAILABLE, status: result.status, unavailable: true };
    const { agents: _agents, ...without } = payload;
    return sendOnce(without, { ...options, timeoutMs: left });
  }
  return result;
}

async function sendOnce(payload: ProductFeedbackPayload, options: SendProductFeedbackOptions): Promise<ProductFeedbackResult> {
  const doFetch = options.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? FEEDBACK_TIMEOUT_MS);
  try {
    const res = await doFetch(options.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    if (res.ok) return { ok: true };
    if (res.status >= 400 && res.status < 500 && res.status !== 404 && res.status !== 405) {
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body.error === "string" && body.error) return { ok: false, reason: body.error.slice(0, 200), status: res.status, unavailable: false };
      } catch {
      }
    }
    return { ok: false, reason: FEEDBACK_UNAVAILABLE, status: res.status, unavailable: true };
  } catch {
    return { ok: false, reason: FEEDBACK_UNAVAILABLE, unavailable: true };
  } finally {
    clearTimeout(timer);
  }
}
