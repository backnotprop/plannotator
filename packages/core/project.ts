export function sanitizeTag(name: string): string | null {
  if (!name || typeof name !== "string") return null;

  const sanitized = name
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-/, "")
    .slice(0, 30)
    .replace(/-$/, "");

  return sanitized.length >= 2 ? sanitized : null;
}

export function extractRepoName(gitRootPath: string): string | null {
  if (!gitRootPath || typeof gitRootPath !== "string") return null;

  const trimmed = gitRootPath.trim().replace(/\/+$/, "");
  const parts = trimmed.split("/");
  const name = parts[parts.length - 1];

  return sanitizeTag(name);
}

export function extractDirName(path: string): string | null {
  if (!path || typeof path !== "string") return null;

  const trimmed = path.trim().replace(/\/+$/, "");
  if (trimmed === "" || trimmed === "/") return null;

  const parts = trimmed.split("/");
  const name = parts[parts.length - 1];

  const skipNames = new Set(["home", "users", "user", "root", "tmp", "var"]);
  if (skipNames.has(name.toLowerCase())) return null;

  return sanitizeTag(name);
}

export function hostnameOrFallback(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
