/** Display name for a project: its folder's real name, not the history-folder slug (which stays the folder key and stored `name`). Same-named projects also name their parent folder; a renamed project's `display_name` is used as is. */

import { shortProjectNames } from "@plannotator/core/inbox-project-labels";

/** Display name by id, by the window's rule. Falls back to the stored `name` when the root has no last segment. */
export function inboxProjectLabels(projects: readonly { id: string; root: string; name: string; display_name?: unknown }[]): Map<string, string> {
  return shortProjectNames(projects);
}
