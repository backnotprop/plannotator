/**
 * What another Tailscale account sees when it opens this computer's Plannotator
 * over the tailnet (the Inbox, or a `--tailscale` review or annotate session).
 * Plannotator is single player: over Tailscale it opens only for the account
 * that owns this computer. A browser gets a small readable page; an API call,
 * the event stream or `/mcp` gets the same words as JSON.
 */

export const TAILNET_NOT_OWNER_CODE = "tailnet_identity_refused";

/** One sentence, for JSON errors and the page alike. */
export function tailnetNotOwnerMessage(what: "Inbox" | "session"): string {
  return what === "Inbox"
    ? "This Inbox belongs to this computer's owner. It opens only for the Tailscale account that owns this computer."
    : "This Plannotator session belongs to this computer's owner. It opens only for the Tailscale account that owns this computer.";
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** The page a browser gets. `login`: the account the request came from, when Tailscale named one. */
export function tailnetNotOwnerPage(what: "Inbox" | "session", login: string | null): string {
  const title = what === "Inbox" ? "This Inbox belongs to this computer's owner" : "This session belongs to this computer's owner";
  const who = login
    ? `<p>You are signed in to Tailscale as <strong>${escapeHtml(login)}</strong>. If this is your computer, open this address from a device signed in to Tailscale with the account that owns it.</p>`
    : "<p>If this is your computer, open this address from a device signed in to Tailscale with the account that owns it.</p>";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Plannotator</title>
<style>
  :root { color-scheme: light dark; --bg: #fafafa; --fg: #1a1a1a; --muted: #5c5c5c; --card: #fff; --line: #e4e4e4; }
  @media (prefers-color-scheme: dark) { :root { --bg: #141414; --fg: #ededed; --muted: #a3a3a3; --card: #1d1d1d; --line: #2e2e2e; } }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body { display: flex; align-items: center; justify-content: center; min-height: 100vh; min-height: 100dvh; padding: 24px 16px;
    background: var(--bg); color: var(--fg); font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  main { width: 100%; max-width: 30rem; padding: 28px 24px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; }
  h1 { margin: 0 0 12px; font-size: 1.25rem; line-height: 1.3; font-weight: 600; text-wrap: balance; }
  p { margin: 0 0 10px; color: var(--muted); overflow-wrap: anywhere; }
  p:last-child { margin-bottom: 0; }
  strong { color: var(--fg); font-weight: 600; }
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p>Plannotator opens over Tailscale only for the Tailscale account that owns this computer.</p>
${who}
</main>
</body>
</html>
`;
}

/**
 * The one line startup prints when config.json `inboxTailscaleAllow` names another login on a machine Tailscale names
 * an owner for: the key only says who the owner is on a tagged machine (which has none), and is ignored otherwise.
 */
export function allowIgnoredLine(owner: string): string {
  return `inboxTailscaleAllow in config.json is ignored: over Tailscale, Plannotator opens only for this computer's owner, ${owner}.`;
}

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

/** The 403: JSON for `/api/…` and `/mcp`, the page for anything a browser navigates to. `code`: the JSON's (no login: `tailnet_identity_required`). */
export function tailnetNotOwnerResponse(
  what: "Inbox" | "session",
  path: string,
  login: string | null,
  code: string = TAILNET_NOT_OWNER_CODE,
): Response {
  if (path.startsWith("/api/") || path === "/mcp") {
    return new Response(JSON.stringify({ error: tailnetNotOwnerMessage(what), code }), {
      status: 403,
      headers: { "Content-Type": "application/json; charset=utf-8", ...NO_STORE },
    });
  }
  return new Response(tailnetNotOwnerPage(what, login), {
    status: 403,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      ...NO_STORE,
    },
  });
}
