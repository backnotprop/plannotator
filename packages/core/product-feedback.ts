/**
 * Product feedback: the one client that sends what a person types about
 * Plannotator to the owner's feedback Worker (apps/feedback-service). The
 * Inbox's server (`POST /api/inbox/feedback`, packages/server/inbox-feedback.ts)
 * and `plannotator feedback` (apps/hook/server/feedback-command.ts) both send
 * through `sendProductFeedback`, so the backend is swapped in one place: the
 * URL constant below, or `PLANNOTATOR_FEEDBACK_URL` (tests point it at a
 * local fake).
 *
 * Nothing is sent without a person's click or an explicit CLI command. A
 * submission carries the message, the optional category and contact the
 * person typed, the Plannotator version, the OS name and where it was sent
 * from; nothing else (no thread content, no paths, no machine id).
 *
 * Browser-safe: no Node or Bun imports. The limits mirror the Worker's
 * (apps/feedback-service/core/validation.ts; its test/limits.test.ts keeps
 * them in step).
 */

/** The feedback Worker's one route. The owner's deploy; swap the backend here. */
export const PRODUCT_FEEDBACK_URL = "https://plannotator-feedback.plannotator.workers.dev/feedback";
/** Overrides PRODUCT_FEEDBACK_URL (an http or https URL). Tests point it at a local server. */
export const PRODUCT_FEEDBACK_URL_ENV = "PLANNOTATOR_FEEDBACK_URL";

export const FEEDBACK_MESSAGE_MAX = 4000;
export const FEEDBACK_CONTACT_MAX = 200;
export const FEEDBACK_CATEGORIES = ["bug", "idea", "other"] as const;
export const FEEDBACK_SURFACES = ["inbox", "plan-review", "code-review", "annotate", "cli"] as const;

export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];
export type FeedbackSurface = (typeof FEEDBACK_SURFACES)[number];

/** What a person typed (the message, and optionally a category and a way to reach them). */
export interface ProductFeedbackInput {
  message: string;
  category?: FeedbackCategory | null;
  contact?: string | null;
}

/** The wire body: the input plus the version, the OS and the surface. Exactly these keys. */
export interface ProductFeedbackPayload {
  message: string;
  category?: FeedbackCategory;
  contact?: string;
  version: string;
  os: string;
  surface: FeedbackSurface;
}

/**
 * What the person reads when the feedback service cannot take the message:
 * unreachable, not deployed, too slow, or failing (a 5xx, a 404/405, an answer
 * that is not the Worker's JSON). One plain line, the same in the dialog and
 * the CLI, never a stack or a status code.
 */
export const FEEDBACK_UNAVAILABLE = "Couldn't send feedback right now; nothing was saved.";

/**
 * The end word of the quoted heredoc that carries the message to
 * `plannotator feedback --stdin` in the copied prompt, the CLI help, the skill
 * and the README. Not `EOF`: feedback about shells can quote a line that is
 * exactly `EOF`, which would end the heredoc early and run the rest as commands.
 */
export const FEEDBACK_HEREDOC_END = "PLANNOTATOR_FEEDBACK_END";

/** How long one send waits for the Worker. Under 10 s, so the window (which goes through its Inbox) has its answer by then. */
export const FEEDBACK_TIMEOUT_MS = 8_000;

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
      // Not a URL: fall back to the constant.
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

/** The exact body sent: the input's words, the version, the OS and the surface. */
export function productFeedbackPayload(input: ProductFeedbackInput, meta: { version: string; os: string; surface: FeedbackSurface }): ProductFeedbackPayload {
  const contact = typeof input.contact === "string" ? input.contact.trim() : "";
  return {
    message: input.message.trim(),
    ...(input.category ? { category: input.category } : {}),
    ...(contact ? { contact } : {}),
    // The Worker accepts a short label; `dev` (a source run) is one.
    version: meta.version.slice(0, 40),
    os: meta.os.slice(0, 40),
    surface: meta.surface,
  };
}

export interface SendProductFeedbackOptions {
  url: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** POSTs one submission. No cookies, no credentials, no redirects; the answer's body is never read beyond its error. */
export async function sendProductFeedback(payload: ProductFeedbackPayload, options: SendProductFeedbackOptions): Promise<ProductFeedbackResult> {
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
    // A refusal is the Worker's 4xx with its JSON error (bad input, too big, too many). A 404 or 405 is
    // a URL with no Worker on it (not deployed); a 5xx or anything else is the service failing.
    if (res.status >= 400 && res.status < 500 && res.status !== 404 && res.status !== 405) {
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body.error === "string" && body.error) return { ok: false, reason: body.error.slice(0, 200), status: res.status, unavailable: false };
      } catch {
        // Not the Worker's JSON: unavailable, below.
      }
    }
    return { ok: false, reason: FEEDBACK_UNAVAILABLE, status: res.status, unavailable: true };
  } catch {
    // Unreachable (DNS, refused, TLS), a redirect, or past the time limit: one plain line, no detail.
    return { ok: false, reason: FEEDBACK_UNAVAILABLE, unavailable: true };
  } finally {
    clearTimeout(timer);
  }
}
