/**
 * The repository's label beside a document, in code review and in the tab
 * title (Settings → General → "Hide the repository owner"). Import-free.
 */

/**
 * `owner/repo` as given, or only its last segment when the owner is hidden:
 * `acme/payments-service` reads `payments-service`, and a GitLab
 * subgroup path `group/sub/project` reads `project`. A label with no owner
 * (the folder-name fallback outside a git remote) is returned unchanged.
 */
export function repoLabel(display: string, hideOwner: boolean): string {
  if (!hideOwner) return display;
  const slash = display.lastIndexOf('/');
  const name = slash === -1 ? display : display.slice(slash + 1);
  return name || display;
}
