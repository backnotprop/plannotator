const BASE_CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

// Defaults target the hosted plannotator.ai site. Override ALLOWED_ORIGINS in
// wrangler.toml or via `wrangler secret put` for self-hosted deployments.
export function getAllowedOrigins(envValue?: string): string[] {
  if (envValue) {
    return envValue.split(",").map((o) => o.trim()).filter(Boolean);
  }
  return ["https://plannotator.ai", "http://localhost:3002"];
}

export function corsHeaders(
  requestOrigin: string,
  allowedOrigins: string[]
): Record<string, string> {
  const isLocalhost = /^https?:\/\/localhost(:\d+)?$/.test(requestOrigin);
  if (
    isLocalhost ||
    allowedOrigins.includes(requestOrigin) ||
    allowedOrigins.includes("*")
  ) {
    return {
      ...BASE_CORS_HEADERS,
      "Access-Control-Allow-Origin": requestOrigin || "*",
      Vary: "Origin",
    };
  }
  return {};
}
