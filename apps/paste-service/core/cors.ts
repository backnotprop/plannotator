const BASE_CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

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
  if (allowedOrigins.includes(requestOrigin) || allowedOrigins.includes("*")) {
    return {
      ...BASE_CORS_HEADERS,
      "Access-Control-Allow-Origin": requestOrigin,
    };
  }
  return {};
}
