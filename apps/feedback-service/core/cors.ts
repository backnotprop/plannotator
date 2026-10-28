// Which browser origins may POST feedback, and the CORS headers they get.
//
// No Plannotator surface needs CORS: the Inbox sends feedback from its own
// local server and `plannotator feedback` from the CLI, and neither sends an
// Origin header. So a request that carries an Origin is a browser page, and it
// is refused (403, no preflight either) unless the owner lists that exact
// origin in `ALLOWED_ORIGINS`. Without that, any page a person visits (a
// localhost dev server, a public `*.ts.net` Funnel site) could make each
// visitor's browser submit, from many IPs past the per-IP limits. CORS is not
// authentication; this only narrows who can submit.

/** Origins from `ALLOWED_ORIGINS` (comma separated, exact matches; `*` is ignored). Empty: no browser origin at all. */
export function parseExtraOrigins(envValue?: string): string[] {
  if (!envValue) return [];
  return envValue
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin && origin !== "*");
}

export function isAllowedOrigin(origin: string, allowed: readonly string[] = []): boolean {
  return allowed.includes(origin);
}

/** The CORS headers for an allowed Origin; none without one. Never credentials. */
export function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
