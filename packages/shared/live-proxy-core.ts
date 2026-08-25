/**
 * Runtime-agnostic core of the live local app annotation proxy.
 *
 * Every DECISION the proxy makes lives here as a pure function, so the Bun
 * transport (packages/server/live-proxy.ts) and the Node transport
 * (packages/shared/live-proxy-node.ts, vendored to Pi) share one
 * implementation instead of drifting copies: the streaming HTML injector
 * state machine, the loopback/Host/Origin validation predicates, the
 * CSP / X-Frame-Options rewrite policy, the WebSocket origin gate, the
 * redirect Location rewrite, and the bridge bootstrap assembly.
 *
 * Nothing in this module may import Bun APIs or node:http — Web-platform
 * globals (URL, TextEncoder) and plain data only. Transports stay thin: they
 * move bytes and call these decisions in the documented order (Host
 * validation FIRST, before any URL construction or upstream contact).
 *
 * Security posture (binding is the contract, not a default):
 * - Transports bind 127.0.0.1 UNCONDITIONALLY. Never the shared
 *   env-dependent hostname helper, never any other interface. A proxy bound
 *   beyond loopback would relay the user's authenticated dev app to the
 *   network.
 * - The Host header is validated before touching upstream (blunts DNS
 *   rebinding).
 * - App CSP is stripped on HTML and replaced with a frame-ancestors policy
 *   listing exactly the editor origins, which simultaneously defeats app
 *   anti-framing headers and prevents hostile sites from framing the proxy.
 * - PLANNOTATOR_URL_HOST / buildAdvertisedUrl are never applied to the proxy
 *   origin.
 */

/** The literal loopback address every transport must bind. */
export const LIVE_PROXY_LOOPBACK_HOST = "127.0.0.1";

/** Reserved path namespace never forwarded upstream. */
export const LIVE_PROXY_RESERVED_PREFIX = "/__plannotator__/";
export const LIVE_PROXY_BRIDGE_PATH = "/__plannotator__/bridge.js";

/** The exact tag the injector plants into proxied HTML documents. */
export const LIVE_PROXY_BRIDGE_TAG = `<script src="${LIVE_PROXY_BRIDGE_PATH}"></script>`;

/** RFC 7230 hop-by-hop headers, stripped in both directions. */
export const HOP_BY_HOP_HEADERS: readonly string[] = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

export function isHopByHopHeader(name: string): boolean {
  return HOP_BY_HOP_HEADERS.includes(name.toLowerCase());
}

/** Cap on client->upstream WS messages queued while the upstream socket is
 * still connecting; overflow closes both sides rather than buffering
 * unboundedly. */
export const LIVE_PROXY_MAX_PENDING_WS_MESSAGES = 200;

export interface LiveAppProxyOptions {
  /** Upstream dev server origin, e.g. http://localhost:5173 (http, loopback). */
  targetUrl: string;
  /** Editor origins allowed to frame the proxied app (frame-ancestors). */
  editorOrigins: string[];
  /** Fully composed bridge body (config prelude + bootstrap + bridge). */
  bridgeJs: string;
}

export interface LiveAppProxy {
  port: number;
  origin: string;
  stop(): void;
}

/** Minimal read view over request headers; DOM Headers satisfies it, and the
 * Node transport adapts node:http's plain header object. */
export interface HeaderReader {
  get(name: string): string | null;
}

/** True for hostnames that name the local loopback: localhost, the IPv6
 * loopback, or a LITERAL IPv4 address in 127.0.0.0/8. A string-prefix test
 * would also match DNS names like 127.0.0.1.evil.example that resolve
 * anywhere, so the 127/8 rung requires exactly four numeric octets. WHATWG
 * URL parsing canonicalizes numeric spellings (127.1, 0177.0.0.1,
 * 2130706433) to dotted-decimal before a hostname reaches this check. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!octets) return false;
  return Number(octets[1]) <= 255 && Number(octets[2]) <= 255 && Number(octets[3]) <= 255;
}

/** True when the Host header names this proxy on loopback. */
export function isAllowedProxyHost(hostHeader: string | null, port: number): boolean {
  if (!hostHeader) return false;
  return (
    hostHeader === `127.0.0.1:${port}`
    || hostHeader === `localhost:${port}`
    || hostHeader === `[::1]:${port}`
  );
}

/** True when a browser-supplied Origin header names this proxy itself. */
export function isAllowedProxyOrigin(origin: string, port: number): boolean {
  return (
    origin === `http://127.0.0.1:${port}`
    || origin === `http://localhost:${port}`
    || origin === `http://[::1]:${port}`
  );
}

/**
 * WebSocket upgrade origin gate. Browsers stamp cross-site WS connects with
 * their Origin, and the proxied upstream connection carries no Origin header
 * at all. Piping a hostile page's connect through would launder it into
 * exactly the origin-less shape dev servers trust as a non-browser client
 * (bypassing e.g. Vite's CVE-2025-24010 cross-site WS protection). An
 * Origin, when present, must name this proxy itself; header-less clients
 * (non-browser tools) pass so HMR keeps working.
 */
export function isAllowedWsUpgradeOrigin(origin: string | null, port: number): boolean {
  return origin === null || isAllowedProxyOrigin(origin, port);
}

/**
 * Sec-Fetch-Site gate on the bridge body. The bridge embeds the per-session
 * token, and a <script src> include is not subject to CORS: a hostile page
 * that guesses the proxy port could otherwise read the token off the config
 * global. Browsers stamp subresource requests with Sec-Fetch-Site; only the
 * proxied page's own same-origin include (and direct navigation) passes.
 * Header-less clients (curl, tests) pass; this is defense in depth on top of
 * the parent's source and origin checks.
 */
export function isAllowedBridgeFetchSite(fetchSite: string | null): boolean {
  return !fetchSite || fetchSite === "same-origin" || fetchSite === "none";
}

/**
 * Rewrite an absolute redirect Location that names the upstream dev server
 * back to the proxy origin, or return null to pass it through untouched.
 * The match is by loopback hostname plus the upstream's port, not a string
 * prefix, so it covers alternate loopback spellings (target given as
 * localhost:5173, Location saying 127.0.0.1:5173) and never mangles
 * prefix look-alikes (localhost:51730 is a different service). Relative
 * Locations already resolve against the proxy origin and pass through.
 */
export function rewriteLoopbackLocation(
  location: string,
  target: URL,
  proxyOrigin: string,
): string | null {
  if (!/^http:\/\//i.test(location)) return null;
  let locUrl: URL;
  try {
    locUrl = new URL(location);
  } catch {
    return null;
  }
  if (!isLoopbackHostname(locUrl.hostname)) return null;
  if ((locUrl.port || "80") !== (target.port || "80")) return null;
  return proxyOrigin + locUrl.pathname + locUrl.search + locUrl.hash;
}

/** Document-intent requests get Accept-Encoding stripped so HTML arrives
 * decodable for injection; asset requests keep their encoding untouched. */
export function isDocumentIntentRequest(headers: HeaderReader): boolean {
  const dest = headers.get("sec-fetch-dest");
  if (dest === "document" || dest === "iframe" || dest === "frame") return true;
  const accept = headers.get("accept");
  return !!accept && accept.includes("text/html");
}

/** Media types are case-insensitive (RFC 9110 8.3): a dev server that
 * answers "TEXT/HTML" is serving HTML, and a case-sensitive test would
 * silently skip both the bridge injection and the framing-header rewrites
 * for it. */
export function isHtmlContentType(contentType: string | null | undefined): boolean {
  return (contentType ?? "").toLowerCase().includes("text/html");
}

/** The frame-ancestors CSP value HTML responses are rewritten to carry. */
export function buildFrameAncestorsPolicy(editorOrigins: readonly string[]): string {
  return `frame-ancestors ${editorOrigins.join(" ")}`;
}

/** Minimal mutable view over response headers for the framing rewrite. */
export interface HeaderMutator {
  delete(name: string): void;
  set(name: string, value: string): void;
}

/**
 * Decided posture, applied to HTML responses ONLY: drop any app CSP and
 * replace it with our frame-ancestors policy. Amending an arbitrary CSP
 * correctly for the injected script plus a runtime <style> is unpredictable;
 * dev servers almost never ship CSP, and this is a dev-only loopback proxy.
 * Non-HTML responses keep their CSP, and their X-Frame-Options: the
 * anti-framing strip exists solely so the editor can frame the app document,
 * and the frame-ancestors replacement lands only on HTML, so a non-HTML
 * response must keep whatever framing protection the app shipped with it.
 */
export function applyHtmlFramingHeaders(headers: HeaderMutator, frameAncestors: string): void {
  headers.delete("x-frame-options");
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  headers.set("content-security-policy", frameAncestors);
}

// --- Streaming HTML injection -----------------------------------------------
//
// Injects exactly one script tag per document, in priority order:
//  1. immediately after the end of the first <head ...> open tag (so
//     streaming SSR gets the bridge before the body streams),
//  2. before </head> when no head open tag was seen,
//  3. appended at end of stream when neither appears.
// Byte-level scan (the markers are ASCII, safe in UTF-8) holding back at most
// 8 bytes across chunk boundaries; a head open tag split across chunks is
// handled by a state machine rather than unbounded buffering.
//
// The scan is comment-aware. Head markers that appear inside a comment are
// not head markers: a codegen banner like
//   <!-- generated file; do not edit <head> by hand -->
// preceding the real document head used to swallow the bridge into a span the
// browser never executes, so annotation broke with no diagnostic at all. The
// scanner therefore skips three kinds of ignored span before matching:
//   - comments:            <!-- ... -->  (also the legacy --!> terminator)
//   - markup declarations
//     and bogus comments:  <!...>  (DOCTYPE, CDATA-ish <![CDATA[ ... )
//   - processing-instruction-ish bogus comments: <?...>
// The last two end at the first ">", which is exactly how the HTML parser
// treats them outside foreign content, so `<![CDATA[<head>]]>` hides the same
// bytes here as it does in a browser.
//
// Honestly out of scope: raw-text element contents are NOT tracked, so a
// literal "<!--" inside a <script> or <style> string that precedes the head
// markers is read as a comment open. Reaching that requires script/style
// content before the document head (invalid in the head-open case, since the
// scan stops at the first <head), and the degraded outcome is the existing
// no-marker fallback (injection appended at end of stream) rather than a
// silent injection into dead bytes. Conditional comments and unterminated
// comments degrade the same way.

const HEAD_OPEN = "<head";
const HEAD_CLOSE = "</head>";
const COMMENT_OPEN = "<!--";
const GT = 0x3e; /* > */
const LT = 0x3c; /* < */
const BANG = 0x21; /* ! */
const QUESTION = 0x3f; /* ? */
const HYPHEN = 0x2d; /* - */
/** Longest marker the scan must be able to defer is "</head>" (7 bytes), so
 * holding back 8 keeps every partial marker available for the next chunk. */
const HOLDBACK = 8;

type InjectorState = "searching" | "in-ignored-span" | "in-head-open-tag" | "done";

export function createHtmlInjector(injection: string) {
  const encoder = new TextEncoder();
  const injectionBytes = encoder.encode(injection);
  let state: InjectorState = "searching";
  /** While in-ignored-span: "comment" ends at --> / --!>, "gt" ends at >. */
  let ignoredSpanKind: "comment" | "gt" = "comment";
  let carry = new Uint8Array(0);

  function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  function lowerAt(buf: Uint8Array, index: number): number {
    const byte = buf[index]!;
    return byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
  }

  function matchesAt(buf: Uint8Array, index: number, marker: string): boolean {
    if (index + marker.length > buf.length) return false;
    for (let i = 0; i < marker.length; i++) {
      if (lowerAt(buf, index + i) !== marker.charCodeAt(i)) return false;
    }
    return true;
  }

  /** True when the byte after "<head" terminates the tag name. */
  function isHeadBoundary(byte: number): boolean {
    return byte === 0x3e /* > */
      || byte === 0x2f /* / */
      || byte === 0x20
      || byte === 0x09
      || byte === 0x0a
      || byte === 0x0c
      || byte === 0x0d;
  }

  /**
   * Classify an ignored span starting at a '<'. Returns null when this is not
   * one, or when the buffer does not yet hold enough bytes to tell "<!--" from
   * a bogus comment: undecided positions fall through to the holdback and are
   * re-examined against the next chunk.
   */
  function ignoredSpanAt(
    buf: Uint8Array,
    i: number,
  ): { kind: "comment" | "gt"; openLength: number } | null {
    const next = buf[i + 1];
    if (next === undefined) return null; // undecided: defer
    if (next === QUESTION) return { kind: "gt", openLength: 2 };
    if (next !== BANG) return null;
    if (matchesAt(buf, i, COMMENT_OPEN)) return { kind: "comment", openLength: COMMENT_OPEN.length };
    // "<!" that is not yet known to be "<!--" (chunk ends mid-marker): defer.
    if (i + COMMENT_OPEN.length > buf.length) return null;
    return { kind: "gt", openLength: 2 };
  }

  /**
   * End of the ignored span that is currently open, or -1 when this buffer
   * does not contain it yet. Comments accept the legacy "--!>" terminator
   * alongside "-->", matching the HTML parser's comment end states.
   */
  function ignoredSpanEnd(buf: Uint8Array, from: number): number {
    if (ignoredSpanKind === "gt") {
      const gt = buf.indexOf(GT, from);
      return gt === -1 ? -1 : gt + 1;
    }
    for (let i = from; i + 2 < buf.length; i++) {
      if (buf[i] !== HYPHEN || buf[i + 1] !== HYPHEN) continue;
      if (buf[i + 2] === GT) return i + 3;
      if (buf[i + 2] === BANG && buf[i + 3] === GT) return i + 4;
    }
    return -1;
  }

  /** Process buffered bytes, returning output and retaining a small carry. */
  function scan(buf: Uint8Array, flush: boolean): Uint8Array[] {
    const out: Uint8Array[] = [];
    let cursor = 0;

    while (cursor < buf.length && state !== "done") {
      if (state === "in-head-open-tag") {
        const gt = buf.indexOf(GT, cursor);
        if (gt === -1) {
          out.push(buf.subarray(cursor));
          cursor = buf.length;
          break;
        }
        out.push(buf.subarray(cursor, gt + 1));
        out.push(injectionBytes);
        state = "done";
        cursor = gt + 1;
        break;
      }

      if (state === "in-ignored-span") {
        // Comment / declaration bytes pass through verbatim; only the search
        // for head markers is suspended until the span closes.
        const end = ignoredSpanEnd(buf, cursor);
        if (end === -1) break; // need more bytes: holdback below
        out.push(buf.subarray(cursor, end));
        cursor = end;
        state = "searching";
        continue;
      }

      // searching: look for the earliest full or partial marker.
      let emitted = false;
      for (let i = cursor; i < buf.length; i++) {
        if (buf[i] !== LT) continue;
        // Comments and declarations hide whatever they contain, head markers
        // included: enter the span before testing for head markers.
        const ignored = ignoredSpanAt(buf, i);
        if (ignored) {
          const openEnd = i + ignored.openLength;
          out.push(buf.subarray(cursor, openEnd));
          cursor = openEnd;
          ignoredSpanKind = ignored.kind;
          state = "in-ignored-span";
          emitted = true;
          break;
        }
        // Full </head> (no head open tag seen): inject before it.
        if (matchesAt(buf, i, HEAD_CLOSE)) {
          out.push(buf.subarray(cursor, i));
          out.push(injectionBytes);
          state = "done";
          cursor = i;
          emitted = true;
          break;
        }
        // <head followed by a boundary char: enter the open tag.
        if (matchesAt(buf, i, HEAD_OPEN) && i + HEAD_OPEN.length < buf.length) {
          if (isHeadBoundary(buf[i + HEAD_OPEN.length]!)) {
            out.push(buf.subarray(cursor, i));
            cursor = i;
            state = "in-head-open-tag";
            emitted = true;
            break;
          }
          continue; // <header> etc.
        }
        // Partial marker at the buffer tail: defer to the holdback below.
      }
      if (!emitted && state === "searching") break;
    }

    if (state === "done") {
      // Everything after the injection point passes through untouched.
      if (cursor < buf.length) out.push(buf.subarray(cursor));
      carry = new Uint8Array(0);
      return out;
    }

    if (state === "in-head-open-tag") {
      // scan() loop above consumed the buffer searching for '>'.
      if (cursor < buf.length) {
        out.push(buf.subarray(cursor));
      }
      carry = new Uint8Array(0);
      return out;
    }

    // searching / in-ignored-span: hold back the trailing bytes that could be
    // a partial marker ("</hea", "<!-", "--"), so the next chunk re-reads them.
    if (flush) {
      // Stream ended with no usable head marker (including inside an
      // unterminated comment): append rather than drop the bridge.
      out.push(buf.subarray(cursor));
      out.push(injectionBytes);
      state = "done";
      carry = new Uint8Array(0);
      return out;
    }
    const keepFrom = Math.max(cursor, buf.length - HOLDBACK);
    out.push(buf.subarray(cursor, keepFrom));
    carry = buf.slice(keepFrom);
    return out;
  }

  return {
    push(chunk: Uint8Array): Uint8Array[] {
      const buf = carry.length ? concat(carry, chunk) : chunk;
      carry = new Uint8Array(0);
      return scan(buf, false);
    },
    flush(): Uint8Array[] {
      const buf = carry;
      carry = new Uint8Array(0);
      if (state === "done") return buf.length ? [buf] : [];
      if (state === "in-head-open-tag") {
        // Stream ended inside the head open tag: emit what we have plus the
        // injection so the bridge still ships.
        state = "done";
        const encoderOut: Uint8Array[] = [];
        if (buf.length) encoderOut.push(buf);
        encoderOut.push(injectionBytes);
        return encoderOut;
      }
      return scan(buf, true);
    },
  };
}

// --- Bridge bootstrap assembly ----------------------------------------------

export interface LiveBridgeSources {
  /** The per-session token the annotate server owns. */
  token: string;
  /** Editor origins, localhost spelling first (matches the advertised URL). */
  editorOrigins: string[];
  /** Annotation CSS installed by the bootstrap. */
  annotationCss: string;
  /** Live-mode bootstrap that installs the CSS and config. */
  bridgeBootstrap: string;
  /** The bridge script itself. */
  bridgeScript: string;
}

/**
 * Compose the proxy-served bridge body: JSON config prelude (the token the
 * annotate server owns, both editor origin forms with the localhost one
 * first to match the advertised URL, and the annotation CSS), then the
 * bootstrap that installs the CSS, then the bridge itself.
 */
export function composeLiveBridgeJs(sources: LiveBridgeSources): string {
  return (
    "window.__plannotatorLiveConfig = "
    + JSON.stringify({
      live: true,
      token: sources.token,
      editorOrigins: sources.editorOrigins,
      css: sources.annotationCss,
    })
    + ";\n"
    + sources.bridgeBootstrap
    + "\n"
    + sources.bridgeScript
  );
}

/** The editor origins allowed to frame the proxied app, for an annotate
 * server listening on `port`. Localhost first: it matches the advertised
 * session URL. */
export function buildLiveEditorOrigins(port: number): string[] {
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}

/**
 * The URL the editor frames for a live session: the proxy under the
 * LOCALHOST spelling, carrying the target URL's own path and query.
 * localhost keeps the framed app same-site with the editor page
 * (buildAdvertisedUrl advertises localhost locally) and shares the dev
 * app's host-only localhost cookies and storage, which a 127.0.0.1
 * spelling would not (and Safari ITP blocks all cookies in cross-site
 * iframes). The proxy itself still BINDS the 127.0.0.1 literal; browsers
 * that resolve localhost to ::1 first fall back to IPv4 on the refused
 * loopback connect. The path matters too: annotating
 * http://localhost:5173/admin must open /admin, not the app root.
 * PLANNOTATOR_URL_HOST is still never applied here.
 */
export function buildLiveAppUrl(proxyPort: number, targetUrl: string): string {
  let targetPath = "/";
  try {
    const parsedTarget = new URL(targetUrl);
    targetPath = parsedTarget.pathname + parsedTarget.search;
  } catch {
    targetPath = "/";
  }
  return `http://localhost:${proxyPort}${targetPath}`;
}

/**
 * Stable identity for a live app session's annotation draft.
 *
 * A live session's draft has to key off WHICH APP is being annotated, since
 * the session holds no document text of its own. Normalizing through the URL
 * parser first so the same dev server recovers its draft when the target is
 * spelled slightly differently on a later run (a trailing slash, an uppercase
 * host, an explicit :80). Unparseable values fall back to the trimmed string:
 * a target that never reached the URL parser cannot have started a proxy
 * anyway, and a per-target key that is merely raw is still per-target.
 */
export function liveAppDraftIdentity(targetUrl: string): string {
  try {
    const url = new URL(targetUrl);
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}${url.search}`;
  } catch {
    return targetUrl.trim();
  }
}
