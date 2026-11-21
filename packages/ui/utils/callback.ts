/**
 * Bot callback integration for Plannotator share URLs.
 *
 * When the bot posts a plan URL with ?cb=<encoded_url>&ct=<token>,
 * these utilities parse the config and POST the user's decision back.
 * A 2xx answer may carry `{ "return_url": "<https url>" }`: the done screen
 * then shows one link back there ("Back to github.com"), which the person
 * clicks. The page never moves by itself: anyone can build a share link with
 * their own bot address, so the person must see where a link goes first.
 */

/** Actions the user can trigger via the in-Plannotator callback buttons. */
export enum CallbackAction {
  Approve  = "approve",
  Feedback = "feedback",
}

/** Callback config parsed from ?cb=<encoded_url>&ct=<token> in the URL. */
export interface CallbackConfig {
  callbackUrl: string;
  token: string;
}

export interface ToastSuccess {
  readonly type: 'success';
  readonly message: string;
  /**
   * A link back to where the bot wants the person to go after the decision
   * landed (the issue or work item the link came from), for the done screen.
   * Read from `return_url` in the callback's 2xx JSON answer and checked by
   * `parseReturnLink`. Absent when the answer names none or a bad one.
   */
  readonly returnLink?: ReturnLink;
}
export interface ToastError   { readonly type: 'error';   readonly message: string }
export type ToastPayload = ToastSuccess | ToastError | null;

/** A link the done screen shows: `href` is what the browser opens, `label` names its host. */
export interface ReturnLink {
  readonly href: string;
  readonly label: string;
}

/** The longest `return_url` the done screen links to. */
export const RETURN_URL_MAX_LENGTH = 2048;

/**
 * Parse callback configuration from URL search params.
 * Checks both the standard query string (before #) and query-style params
 * embedded in the hash (e.g. `#<hash>?cb=...&ct=...`).
 *
 * The decoded `cb` value must use http: or https: — other schemes (file://, javascript://, etc.)
 * are rejected to prevent protocol-based attacks.
 *
 * @param loc - Location object to parse (defaults to window.location; injectable for tests)
 * @returns CallbackConfig if both cb and ct are present and valid, null otherwise
 */
export function getCallbackConfig(
  loc: { readonly search: string; readonly hash: string } = window.location,
): CallbackConfig | null {
  const searchParams = new URLSearchParams(loc.search);
  let cb = searchParams.get("cb");
  let ct = searchParams.get("ct");

  if (!cb || !ct) {
    const qIdx = loc.hash.indexOf("?");
    if (qIdx !== -1) {
      const hashParams = new URLSearchParams(loc.hash.slice(qIdx + 1));
      cb = cb ?? hashParams.get("cb");
      ct = ct ?? hashParams.get("ct");
    }
  }

  if (!cb || !ct) return null;

  try {
    const { protocol } = new URL(cb);
    if (protocol !== "https:" && protocol !== "http:") return null;
  } catch {
    return null; // malformed URL
  }

  return { callbackUrl: cb, token: ct };
}

/**
 * Check a bot's `return_url` and build the done screen's link from it.
 *
 * Kept: a string of at most `RETURN_URL_MAX_LENGTH` characters that parses as
 * an https: URL with no user name or password. Anything else gives undefined.
 * The link goes to the parsed `href` and its label names the parsed
 * `hostname`, so the label is the host the browser will open (an
 * internationalized name shows in its xn-- form, so a look-alike shows).
 */
export function parseReturnLink(raw: unknown): ReturnLink | undefined {
  if (typeof raw !== "string" || raw === "" || raw.length > RETURN_URL_MAX_LENGTH) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hostname === "") {
    return undefined;
  }
  return { href: url.href, label: `Back to ${url.hostname}` };
}

/**
 * Read an optional `return_url` from a callback's 2xx answer. Any other
 * answer (empty, not JSON, no field, a value `parseReturnLink` refuses)
 * gives undefined, so the decision still counts as sent.
 */
/** How long the done screen waits for the bot's answer body before showing without a link. */
export const RETURN_LINK_READ_TIMEOUT_MS = 3000;

async function readReturnLink(res: Response, timeoutMs = RETURN_LINK_READ_TIMEOUT_MS): Promise<ReturnLink | undefined> {
  let body: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // The decision is already sent. A body that never ends must not hold the done screen.
    body = await Promise.race([
      res.json(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (!body || typeof body !== "object") return undefined;
  return parseReturnLink((body as { return_url?: unknown }).return_url);
}

/**
 * Execute a bot callback POST request.
 *
 * Pure function (no React deps) — testable without a DOM.
 *
 * @param action - The action to send
 * @param config - Callback URL and single-use token from `getCallbackConfig()`
 * @param annotatedUrl - Current share URL (with annotations encoded); sent to the bot
 * @returns Toast payload to display
 */
export async function executeCallback(
  action: CallbackAction,
  config: CallbackConfig,
  annotatedUrl: string,
  returnLinkTimeoutMs: number = RETURN_LINK_READ_TIMEOUT_MS,
): Promise<ToastPayload> {
  const successMsg = action === CallbackAction.Approve
    ? "Plan approved! The bot will proceed to implementation."
    : "Feedback sent! The bot will re-plan with your annotations.";
  try {
    const res = await fetch(config.callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, token: config.token, annotated_url: annotatedUrl }),
    });
    if (!res.ok) {
      return {
        type: "error",
        message: res.status === 401
          ? "Plan link expired — request a new one from the bot."
          : "Callback failed.",
      };
    }
    const returnLink = await readReturnLink(res, returnLinkTimeoutMs);
    return returnLink
      ? { type: "success", message: successMsg, returnLink }
      : { type: "success", message: successMsg };
  } catch {
    return { type: "error", message: "Callback failed." };
  }
}
