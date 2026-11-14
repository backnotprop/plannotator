/**
 * Plannotator Inbox: a trusted app on this computer framing the window
 * (#3299, config.json `inboxFrameAncestors`, read once at start).
 *
 * Unset or empty, every answer is as it always was: the window sends
 * `X-Frame-Options: DENY` and `frame-ancestors 'none'`, and the documents the
 * window frames itself (attached pages, html fences, the tour's mock) send
 * `frame-ancestors 'self'`. With origins listed, on the window's own port only
 * (never the tailnet listener, never a request the device door handed in),
 * the window drops `X-Frame-Options` (it cannot name a list) and sends
 * `frame-ancestors <list>`, and those documents send `'self' <list>`, because
 * frame-ancestors is checked against every ancestor up to the top.
 *
 * Framing grants nothing else: the frame's requests come from the window's
 * own origin, and a request from the host page itself still meets the write
 * and read guards (`Origin` and `Sec-Fetch-Site`) as any other site does.
 *
 * Only exact origins of an app on this computer are kept: `http(s)` on a
 * loopback or `.localhost` name with its port, or an app scheme with a host
 * (`app://hermes`, `tauri://localhost`). A wildcard, `'self'`, `file:`, a
 * scheme alone, a path, or any other host is dropped with one stderr line, so
 * nothing in the list can widen the policy or add a directive to it.
 */
import { isLocalhostHostname, isLoopbackHostname } from "@plannotator/shared/loopback-host";

/** No listed framers: every answer as it always was. */
export const NO_FRAME_ANCESTORS: readonly string[] = Object.freeze([]);

/** Schemes that name no app of the person's own, or that any page could stand behind. */
const REFUSED_SCHEMES = new Set([
  "about",
  "blob",
  "chrome",
  "chrome-extension",
  "data",
  "devtools",
  "file",
  "filesystem",
  "http",
  "https",
  "javascript",
  "moz-extension",
  "safari-web-extension",
  "view-source",
  "ws",
  "wss",
]);

const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
/** `scheme://host[:port]`, nothing after: parsed by hand, since `new URL("app://x").origin` is "null". */
const APP_ORIGIN = new RegExp(`^([a-z][a-z0-9+.-]*)://${LABEL}(?:\\.${LABEL})*(?::(\\d{1,5}))?$`);

/** One entry as the policy will name it, or null when it is not an exact origin of an app on this computer. */
export function inboxFrameAncestor(entry: unknown): string | null {
  if (typeof entry !== "string") return null;
  const value = entry.trim().toLowerCase();
  if (value === "" || value.includes("*")) return null;
  if (value.startsWith("http://") || value.startsWith("https://")) {
    if (!URL.canParse(value)) return null;
    const url = new URL(value);
    // `origin` drops a path, query, credentials and a default port, so equality means the entry was exactly one origin.
    if (url.origin !== value || url.port === "") return null;
    return isLoopbackHostname(url.hostname) || isLocalhostHostname(url.hostname) ? value : null;
  }
  const app = APP_ORIGIN.exec(value);
  if (!app || REFUSED_SCHEMES.has(app[1]!)) return null;
  if (app[2] !== undefined && (Number(app[2]) < 1 || Number(app[2]) > 65535)) return null;
  return value;
}

/**
 * config.json `inboxFrameAncestors`, kept entries only, each once, in the
 * order written. `warn` hears one line per entry it drops.
 */
export function resolveInboxFrameAncestors(value: unknown, warn: (line: string) => void = () => {}): readonly string[] {
  if (value === undefined || value === null) return NO_FRAME_ANCESTORS;
  if (!Array.isArray(value)) {
    warn("Inbox: config.json inboxFrameAncestors is not a list of origins, so nothing may frame the Inbox.\n");
    return NO_FRAME_ANCESTORS;
  }
  const kept: string[] = [];
  for (const entry of value) {
    const origin = inboxFrameAncestor(entry);
    if (origin === null) {
      const shown = JSON.stringify(typeof entry === "string" ? entry.slice(0, 120) : entry) ?? String(entry);
      warn(`Inbox: config.json inboxFrameAncestors: ${shown} is not used. List exact origins of an app on this computer, such as "app://myapp" or "http://localhost:5173".\n`);
      continue;
    }
    if (!kept.includes(origin)) kept.push(origin);
  }
  return kept.length === 0 ? NO_FRAME_ANCESTORS : Object.freeze(kept);
}

/**
 * `csp` with the listed framers added to its `frame-ancestors`: `'none'` is
 * replaced by the list, any other sources (`'self'`) keep their place in
 * front of it. No framers, or no such directive: `csp` as it is.
 */
export function withFrameAncestors(csp: string, framers: readonly string[]): string {
  if (framers.length === 0) return csp;
  return csp.replace(/(^|;\s*)frame-ancestors ([^;]*)/, (_, lead: string, sources: string) => {
    const kept = sources.trim() === "'none'" ? "" : `${sources.trim()} `;
    return `${lead}frame-ancestors ${kept}${framers.join(" ")}`;
  });
}

/** The window page's headers for these framers: without them, `headers` as they are; with them, no `X-Frame-Options`. */
export function framedWindowHeaders(headers: Readonly<Record<string, string>>, framers: readonly string[]): Record<string, string> {
  if (framers.length === 0) return { ...headers };
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "x-frame-options") continue;
    out[name] = name.toLowerCase() === "content-security-policy" ? withFrameAncestors(value, framers) : value;
  }
  return out;
}
