/**
 * "Keep this space": the sign-in Spaces has for a tool on this computer. A browser page at Spaces
 * (`/cli/login`) asks the signed-in person to allow it, then sends the browser back to a listener on this computer
 * (`http://127.0.0.1:<port>/callback`) with a short-lived code, which is traded with its PKCE verifier for a token
 * (`POST /cli/token`). The listener is this sign-in's own: one port, loopback only, closed once the code came, the
 * person cancelled or the wait ran out. The `state` it made is the only thing it answers to.
 *
 * The token is returned to the caller, which keeps it (credential.ts). It is never logged and never in a URL: the
 * login URL carries the challenge, never the verifier or a token.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { SpacesCredential } from "./credential";

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export interface SpacesPkce {
  verifier: string;
  challenge: string;
  state: string;
}

export function newSpacesPkce(): SpacesPkce {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()), state: base64url(randomBytes(24)) };
}

/** The page the browser opens: the challenge and the way back, nothing secret. */
export function spacesLoginUrl(host: string, input: { redirectUri: string; state: string; challenge: string }): string {
  const url = new URL("/cli/login", host);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** Trade the code for the token. Null when the space refused it or did not answer with one. */
export async function exchangeSpacesCode(host: string, input: { code: string; verifier: string }, doFetch: typeof fetch = fetch): Promise<SpacesCredential | null> {
  try {
    const response = await doFetch(`${host}/cli/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ code: input.code, code_verifier: input.verifier }),
      redirect: "error",
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown> | null;
    const token = body && (typeof body.token === "string" ? body.token : typeof body.access_token === "string" ? body.access_token : null);
    if (!token) return null;
    const user = body.user && typeof body.user === "object" ? (body.user as Record<string, unknown>) : body;
    const name = typeof user.name === "string" && user.name.trim() ? user.name.trim() : null;
    return { token, name };
  } catch {
    return null;
  }
}

const DONE_PAGE = (words: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Plannotator</title><style>html{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif}</style></head><body><p>${words}</p></body></html>`;

export interface SpacesSignIn {
  /** The page to open in the browser. */
  url: string;
  /** The credential once the person allowed it; null when cancelled, refused or never finished. */
  done: Promise<SpacesCredential | null>;
  cancel(): void;
}

/** Start the listener and say which page to open. The sign-in ends by itself after `timeoutMs` (10 minutes). */
export async function startSpacesSignIn(options: { host: string; fetch?: typeof fetch; timeoutMs?: number }): Promise<SpacesSignIn> {
  const pkce = newSpacesPkce();
  let settle: (credential: SpacesCredential | null) => void = () => {};
  const done = new Promise<SpacesCredential | null>((resolve) => (settle = resolve));
  let used = false;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const answer = (status: number, words: string, after?: () => void) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", Connection: "close" });
      res.end(DONE_PAGE(words), after);
    };
    if (req.method !== "GET" || url.pathname !== "/callback" || used || url.searchParams.get("state") !== pkce.state) return answer(404, "Not found.");
    used = true;
    const code = url.searchParams.get("code");
    void (code ? exchangeSpacesCode(options.host, { code, verifier: pkce.verifier }, options.fetch) : Promise.resolve(null)).then((credential) => {
      answer(credential ? 200 : 400, credential ? "Signed in. You can close this tab." : "Sign-in did not finish. You can close this tab.", () => finish(credential));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  const timer = setTimeout(() => finish(null), options.timeoutMs ?? 10 * 60_000);
  (timer as { unref?: () => void }).unref?.();
  function finish(credential: SpacesCredential | null) {
    clearTimeout(timer);
    server.close();
    (server as { closeIdleConnections?: () => void }).closeIdleConnections?.();
    settle(credential);
  }
  return {
    url: spacesLoginUrl(options.host, { redirectUri: `http://127.0.0.1:${port}/callback`, state: pkce.state, challenge: pkce.challenge }),
    done,
    cancel: () => finish(null),
  };
}
