/**
 * Bun adapter for the network key (packages/shared/network-key.ts, #956).
 * Every Bun session server (plan, review, annotate, goal setup) builds one
 * guard at start and runs it right after the Host allowlist in `fetch`, before
 * any route, so the app HTML, every API, EventSource streams and WebSocket
 * upgrades are covered alike. It is on only in a remote session that SSH alone
 * turned on (`isSshDetectedRemote`); everywhere else `check` returns null. The
 * Pi mirror is apps/pi-extension/server/network-key-guard.ts.
 */

import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import {
  loadNetworkKey,
  NETWORK_KEY_REFUSAL_HTML,
  NETWORK_KEY_REQUIRED_CODE,
  networkKeyRefusalBody,
  networkKeyVerdict,
} from "@plannotator/shared/network-key";
import { isSshDetectedRemote } from "./remote";
import { peerOf } from "./this-machine";

export interface NetworkKeyGuard {
  /** The answer for a request without the key (or the cookie-setting redirect), else null. */
  check(req: Request): Response | null;
}

/** Build the guard for one server. Env is read once, here. Call `notePeer` before `check`. */
export function createNetworkKeyGuard(): NetworkKeyGuard {
  if (!isSshDetectedRemote()) return { check: () => null };
  const key = loadNetworkKey(getPlannotatorDataDir());
  return {
    check(req) {
      // Parsed once, as the router parses it (packages/shared/network-key.ts).
      let url: URL;
      try {
        url = new URL(req.url);
      } catch {
        return refusal(false);
      }
      const verdict = networkKeyVerdict(
        {
          method: req.method,
          pathname: url.pathname,
          search: url.search,
          peer: peerOf(req),
          cookie: req.headers.get("cookie"),
          secFetchDest: req.headers.get("sec-fetch-dest"),
          accept: req.headers.get("accept"),
          upgrade: (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket",
        },
        key,
      );
      if (verdict.kind === "pass") return null;
      if (verdict.kind === "keep") {
        return new Response(null, {
          status: 303,
          headers: { Location: verdict.location, "Set-Cookie": verdict.setCookie, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
        });
      }
      return refusal(verdict.page);
    },
  };
}

function refusal(page: boolean): Response {
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Plannotator-Error": NETWORK_KEY_REQUIRED_CODE };
  if (page) {
    return new Response(NETWORK_KEY_REFUSAL_HTML, { status: 401, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
  }
  return Response.json(networkKeyRefusalBody(), { status: 401, headers });
}
