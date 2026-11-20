/**
 * "Keep this space": the sign-in Spaces has for a tool on this computer. A browser page at Spaces
 * (`/cli/login`) asks the signed-in person to allow it, then sends the browser back to a listener on this computer
 * (`http://127.0.0.1:<port>/callback`) with a short-lived code (120 seconds, single use), which is traded once with
 * its PKCE verifier and the same way back for a token (`POST /cli/token`, a form body). The person's name is read
 * after, with the token (`GET /v1/me`). The listener is this sign-in's own: one port, loopback only, closed once the code came, the
 * person cancelled or the wait ran out. The `state` it made is the only thing it answers to.
 *
 * The token is returned to the caller, which keeps it (credential.ts). It is never logged and never in a URL: the
 * login URL carries the challenge, never the verifier or a token.
 *
 * The page is the space's "connect a tool" page: `client_name` always (the space answers the person's Cancel only
 * when it was sent), `space` when the sign-in keeps a known space (the claim is made on that page), and
 * `approve_document` + `approve_version` when the person's approval goes with it. The way back says which: a `code`
 * (with `approval=recorded|moved|none` when an approval was asked; absent is none), `error=access_denied` (Cancel)
 * or `error=claim_conflict` (someone else kept the space first; no code).
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

/** The name the space shows for this tool on its connect page (it refuses a name it does not know). */
export const SPACES_CLIENT_NAME = "Plannotator";

/** What the sign-in page is asked besides the sign-in: the space it keeps, and the approval that goes with it. */
export interface SpacesKeepAsk {
  /** The hosted space's id: the page claims it for the person. */
  space?: string | null;
  /** The hosted page and the version the person approved: the page records the approval with the claim. */
  approve?: { document: string; version: string } | null;
}

/** The page the browser opens: the challenge, the way back and what it keeps, nothing secret. */
export function spacesLoginUrl(host: string, input: { redirectUri: string; state: string; challenge: string } & SpacesKeepAsk): string {
  const url = new URL("/cli/login", host);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("client_name", SPACES_CLIENT_NAME);
  if (input.space) {
    url.searchParams.set("space", input.space);
    // An approval goes only with the space it is in.
    if (input.approve) {
      url.searchParams.set("approve_document", input.approve.document);
      url.searchParams.set("approve_version", input.approve.version);
    }
  }
  return url.toString();
}

/** What the page did with an approval sent along: recorded, the page had moved on (not recorded), or nothing. */
export type SpacesApprovalOutcome = "recorded" | "moved" | "none";

/**
 * How a sign-in ended. `signed_in`: the token (and `approval`, only when one was asked). `cancelled`: the person pressed
 * Cancel on the page. `claim_conflict`: someone else kept the space first; no token. `failed`: the code was refused, the
 * wait ran out, or it was given up here.
 */
export type SpacesSignInResult =
  | { kind: "signed_in"; credential: SpacesCredential; approval: SpacesApprovalOutcome | null }
  | { kind: "cancelled" }
  | { kind: "claim_conflict" }
  | { kind: "failed" };

const approvalOutcomeOf = (value: string | null): SpacesApprovalOutcome => (value === "recorded" || value === "moved" ? value : "none");

/**
 * Trade the code for the token: one form-encoded `POST /cli/token` with `grant_type`, `code`, the `redirect_uri` that
 * went to `/cli/login` (byte for byte) and the verifier. Nothing else rides on it: no Origin, no cookie, no
 * Authorization. Never tried twice: the space spends a code on its first lookup, so a second try always fails. Null
 * when the space refused it or did not answer with a token. The name is the account's (`GET /v1/me`), and a sign-in
 * that cannot read it still finishes, with no name.
 */
export async function exchangeSpacesCode(host: string, input: { code: string; verifier: string; redirectUri: string }, doFetch: typeof fetch = fetch): Promise<SpacesCredential | null> {
  let token: string | null = null;
  try {
    const response = await doFetch(`${host}/cli/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri, code_verifier: input.verifier }).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown> | null;
    token = body && typeof body.access_token === "string" && body.access_token.length > 0 ? body.access_token : null;
  } catch {
    return null;
  }
  if (!token) return null;
  return { token, name: await spacesAccountName(host, token, doFetch) };
}

/** The signed-in account's display name (`name` on `GET /v1/me`, and nothing else of that answer), or null. */
async function spacesAccountName(host: string, token: string, doFetch: typeof fetch): Promise<string | null> {
  try {
    const response = await doFetch(`${host}/v1/me`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown> | null;
    const name = body && typeof body.name === "string" ? body.name.trim() : "";
    return name ? name.slice(0, 200) : null;
  } catch {
    return null;
  }
}

const DONE_PAGE = (words: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Plannotator</title><style>html{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif}</style></head><body><p>${words}</p></body></html>`;

/** How long the end of a sign-in waits for its page to be written before it ends anyway. */
const AFTER_WRITE_MS = 2000;

export interface SpacesSignIn {
  /** The page to open in the browser. */
  url: string;
  /** How it ended: the credential once the person allowed it, else why not. */
  done: Promise<SpacesSignInResult>;
  cancel(): void;
}

/** Start the listener and say which page to open. The sign-in ends by itself after `timeoutMs` (10 minutes). */
export async function startSpacesSignIn(options: { host: string; fetch?: typeof fetch; timeoutMs?: number; keep?: SpacesKeepAsk }): Promise<SpacesSignIn> {
  const pkce = newSpacesPkce();
  const space = options.keep?.space ?? null;
  const approveAsked = !!space && !!options.keep?.approve;
  let settle: (result: SpacesSignInResult) => void = () => {};
  const done = new Promise<SpacesSignInResult>((resolve) => (settle = resolve));
  let used = false;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const answer = (status: number, words: string, after?: () => void) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", Connection: "close" });
      // The sign-in ends once the page is written, or soon after in any case: a browser that dropped the connection
      // first may never let the write finish, and the panel must not wait the whole 10 minutes for it.
      let ran = false;
      const once = after
        ? () => {
            if (ran) return;
            ran = true;
            clearTimeout(fallback);
            after();
          }
        : undefined;
      const fallback = once ? setTimeout(once, AFTER_WRITE_MS) : undefined;
      (fallback as { unref?: () => void } | undefined)?.unref?.();
      res.end(DONE_PAGE(words), once);
    };
    if (req.method !== "GET" || url.pathname !== "/callback" || used || url.searchParams.get("state") !== pkce.state) return answer(404, "Not found.");
    used = true;
    const error = url.searchParams.get("error");
    // The person pressed Cancel: back to where it was, nothing to say.
    if (error === "access_denied") return answer(200, "You can close this tab.", () => finish({ kind: "cancelled" }));
    // Someone else kept the space first (only a sign-in that named a space can lose a claim).
    if (error === "claim_conflict" && space) return answer(409, "Sign-in did not finish. You can close this tab.", () => finish({ kind: "claim_conflict" }));
    const code = error ? null : url.searchParams.get("code");
    const approval = approveAsked ? approvalOutcomeOf(url.searchParams.get("approval")) : null;
    // Loaded once only (`used`): a second load of the page finds nothing here, and the code is never traded twice.
    void (code ? exchangeSpacesCode(options.host, { code, verifier: pkce.verifier, redirectUri }, options.fetch) : Promise.resolve(null)).then((credential) => {
      answer(credential ? 200 : 400, credential ? "Signed in. You can close this tab." : "Sign-in did not finish. You can close this tab.", () => finish(credential ? { kind: "signed_in", credential, approval } : { kind: "failed" }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  // The one way back, made once: the login page and the exchange get this same string (the space compares them).
  // `127.0.0.1` literally: the space refuses `localhost`.
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const timer = setTimeout(() => finish({ kind: "failed" }), options.timeoutMs ?? 10 * 60_000);
  (timer as { unref?: () => void }).unref?.();
  function finish(result: SpacesSignInResult) {
    clearTimeout(timer);
    server.close();
    (server as { closeIdleConnections?: () => void }).closeIdleConnections?.();
    settle(result);
  }
  return {
    url: spacesLoginUrl(options.host, { redirectUri, state: pkce.state, challenge: pkce.challenge, space, approve: approveAsked ? options.keep!.approve : null }),
    done,
    cancel: () => finish({ kind: "failed" }),
  };
}
