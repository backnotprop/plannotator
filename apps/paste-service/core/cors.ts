const BASE_CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

// Defaults target the hosted plannotator.ai deployment.
// Self-hosters should set PASTE_ALLOWED_ORIGINS (Bun) or ALLOWED_ORIGINS (Cloudflare)
// to their own portal origin so requests from the hosted share.plannotator.ai
// portal are not granted CORS access against their service.
export function getAllowedOrigins(envValue?: string): string[] {
  if (envValue) {
    return envValue.split(",").map((o) => o.trim());
  }
  return ["https://share.plannotator.ai", "http://localhost:3001"];
}

export function corsHeaders(
  requestOrigin: string,
  allowedOrigins: string[]
): Record<string, string> {
  const isLocalhost = /^https?:\/\/localhost(:\d+)?$/.test(requestOrigin);
  if (isLocalhost || allowedOrigins.includes(requestOrigin) || allowedOrigins.includes("*")) {
    return {
      ...BASE_CORS_HEADERS,
      "Access-Control-Allow-Origin": requestOrigin,
    };
  }
  return {};
}
