/**
 * The name the Inbox shows for a project: the real name of its folder, read
 * from the project's stored root, never the history-folder slug the project
 * was created with (`sanitizeTag` keeps only a-z, 0-9 and hyphens and cuts at
 * 30 characters, so a Japanese repository read "project" and a long one ended
 * in a stray hyphen). The slug stays what it is: the project's folder key and
 * its stored `name`. Nothing on disk is rewritten, so a project created before
 * this reads its real name on the next start.
 *
 * When two projects have the same folder name, each also names its parent
 * folder ("api · work", "api · personal"), the fewest that tell it apart; a
 * checkout in a `worktrees` folder is named for its repository. The rule is
 * the window's, one copy in core.
 *
 * A project the person renamed (`display_name`, Rename… in the project menu)
 * reads that name as it is: no parent is added to it, and it takes no part in
 * the others' clashes. Pure.
 */

import { shortProjectNames } from "@plannotator/core/inbox-project-labels";

/**
 * Each project's display name by id: the window's rule (`@plannotator/core/inbox-project-labels`), over
 * the projects given (every stored project, for the store). A checkout in a `worktrees` folder reads as its
 * repository ("appnotes" for `appnotes/worktrees/main`), as the window shows it. `name` (the stored slug) is
 * the fallback when the root has no last segment (a filesystem root).
 */
export function inboxProjectLabels(projects: readonly { id: string; root: string; name: string; display_name?: unknown }[]): Map<string, string> {
  return shortProjectNames(projects);
}
