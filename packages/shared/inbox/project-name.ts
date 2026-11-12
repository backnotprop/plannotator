import { shortProjectNames } from "@plannotator/core/inbox-project-labels";

export function inboxProjectLabels(projects: readonly { id: string; root: string; name: string; display_name?: unknown }[]): Map<string, string> {
  return shortProjectNames(projects);
}
