/**
 * Shared live-app eligibility probe for annotate URL targets.
 *
 * One implementation of the "does this loopback URL front a live dev app?"
 * decision, used by the Bun CLI's annotate resolution
 * (apps/hook/server/annotate-resolution.ts) and the Pi extension's annotate
 * command (vendored to generated/). Both hosts must probe identically: same
 * 3s timeout, same `accept: text/html` request, same "any status < 500"
 * gate, same final-response redirect rule — a drifting copy here would make
 * the same URL open live on one agent and static on another.
 *
 * Pure Web-platform code: global fetch + AbortSignal.timeout, no Bun or
 * node:http APIs.
 */

import { isLoopbackHostname } from "./live-proxy-core";

export const LIVE_PROBE_TIMEOUT_MS = 3000;

export interface LiveAppCandidate {
  parsed: URL | null;
  /** The URL parsed and its hostname is loopback (localhost / ::1 / 127/8). */
  loopback: boolean;
}

/** Parse an annotate URL target and classify its live-mode candidacy. */
export function classifyLiveAppCandidate(url: string): LiveAppCandidate {
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  return { parsed, loopback: parsed !== null && isLoopbackHostname(parsed.hostname) };
}

export interface LiveAppProbeResult {
  liveEligible: boolean;
  /** Fetch-level failure message, when the probe never completed. */
  probeError: string | null;
  /** Final URL when the probe redirected off the target's loopback origin. */
  probeRedirectedTo: string | null;
}

/**
 * Probe a loopback http URL for live eligibility. Live eligibility is judged
 * on the FINAL response after redirects: a loopback URL that 302s off its
 * own origin (auth portal, tunnel splash page, another local service) must
 * not open a live session whose iframe immediately navigates off the proxy;
 * same-server redirects (/ to /login) stay live-eligible. Any status < 500
 * with an HTML content type qualifies, so a login page or SPA 404 still
 * opens live.
 */
export async function probeLiveAppTarget(
  targetUrl: string,
  parsedUrl: URL,
  fetchImpl: typeof fetch = fetch,
): Promise<LiveAppProbeResult> {
  let liveEligible = false;
  let probeError: string | null = null;
  let probeRedirectedTo: string | null = null;
  try {
    const probe = await fetchImpl(targetUrl, {
      headers: { accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(LIVE_PROBE_TIMEOUT_MS),
    });
    const contentType = probe.headers.get("content-type") ?? "";
    let finalOnOrigin = false;
    try {
      const finalUrl = new URL(probe.url || targetUrl);
      finalOnOrigin =
        finalUrl.protocol === "http:"
        && isLoopbackHostname(finalUrl.hostname)
        && (finalUrl.port || "80") === (parsedUrl.port || "80");
      if (!finalOnOrigin) probeRedirectedTo = probe.url;
    } catch {
      finalOnOrigin = false;
    }
    liveEligible = probe.status < 500 && contentType.includes("text/html") && finalOnOrigin;
  } catch (err) {
    probeError = err instanceof Error ? err.message : String(err);
  }
  return { liveEligible, probeError, probeRedirectedTo };
}

// --- Shared user-facing messages ---------------------------------------------
// Wording is shared so a Pi user and a CLI user read the SAME explanation for
// the same condition; hosts differ only in the channel (stderr vs notify).

/** --app given with a file/folder target. */
export const LIVE_APP_REQUIRES_URL_MESSAGE =
  "--app requires a URL target (a running local app, e.g. http://localhost:5173)";

/** --app given with a non-loopback URL. */
export const LIVE_APP_REQUIRES_LOOPBACK_MESSAGE = "--app requires a localhost/loopback URL";

/** --app given with an https URL (the live proxy is http-only). */
export const LIVE_APP_REQUIRES_HTTP_MESSAGE =
  "--app requires an http:// URL (the live app proxy does not support https upstreams)";

/** Live sessions are hard-off in remote mode; no override env var exists. */
export const LIVE_APP_REMOTE_MESSAGE =
  "Live app annotation is unavailable in remote mode (PLANNOTATOR_REMOTE). Run locally, or use --static to annotate a converted snapshot of the page.";

/** The --app forced-live failure, keyed on what the probe found. */
export function buildForceAppFailureMessage(
  targetUrl: string,
  probe: LiveAppProbeResult,
): string {
  if (probe.probeError !== null) {
    return `--app: could not reach ${targetUrl}: ${probe.probeError}`;
  }
  if (probe.probeRedirectedTo !== null) {
    return `--app: ${targetUrl} redirected off its loopback origin (${probe.probeRedirectedTo}); live mode requires the app to serve HTML from the probed origin`;
  }
  return `--app: ${targetUrl} did not return an HTML page`;
}

/**
 * Fallback notice when a live-eligible-looking URL probed as unreachable and
 * the session degrades to static conversion. A dev server still starting up
 * probes as unreachable, and a silent downgrade to static conversion reads
 * as a broken live session, so the notice names the condition and the
 * retry-with---app escape hatch.
 */
export function buildLiveProbeFallbackNotice(targetUrl: string, probeError: string): string {
  return (
    `Live probe failed for ${targetUrl} (${probeError}); using static conversion. `
    + `If a dev server is still starting up, retry with --app to force live mode.`
  );
}
