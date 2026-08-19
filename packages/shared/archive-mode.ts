const ARCHIVE_POST_MUTATIONS = new Set([
  "/api/approve",
  "/api/deny",
  "/api/draft",
  "/api/save-notes",
  "/api/upload",
]);

/**
 * Return whether an HTTP request would mutate document-review state and must
 * therefore be rejected by the standalone archive server.
 */
export function isArchiveDocumentMutation(method: string, pathname: string): boolean {
  return (method === "POST" && ARCHIVE_POST_MUTATIONS.has(pathname))
    || (method === "DELETE" && pathname === "/api/draft");
}
