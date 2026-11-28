/**
 * What a row's lead (`LeadLine`: the agents and the project) draws: the project and its mark unless the list leaves
 * the project out (Project off, or one project's list), and the agents' tiles unless Agent icons is off (the list
 * column's class hides them, their names stay for a screen reader).
 */
export function leadParts(filtered: boolean, noAgents: boolean): { project: boolean; agents: boolean } {
  return { project: !filtered, agents: !noAgents };
}

/** A name-first row's second line draws nothing (`leadParts`): only then is it folded away; otherwise the row is as it always was. */
export function leadEmpty(filtered: boolean, noAgents: boolean): boolean {
  const parts = leadParts(filtered, noAgents);
  return !parts.project && !parts.agents;
}
