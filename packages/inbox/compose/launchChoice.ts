import { launchChoiceLine, launchEffortsFor, type InboxLaunchChoice, type InboxLaunchChoices, type InboxLaunchChoicesUnread } from '@plannotator/core/inbox-launch-choice';

export { initialLaunchChoice } from '@plannotator/core/inbox-launch-choice';

export function pickLaunchModel(choice: InboxLaunchChoice, choices: InboxLaunchChoices, model: string | null): InboxLaunchChoice {
  const next: InboxLaunchChoice = model ? { model } : {};
  if (choice.effort && launchEffortsFor(choices, next.model).includes(choice.effort)) next.effort = choice.effort;
  if (choice.primary_agent) next.primary_agent = choice.primary_agent;
  return next;
}

export const shortLaunchModel = (model: string) => model.slice(model.lastIndexOf('/') + 1);

/** The model menu shows (a Model column): listed models, or OpenCode's list being read or not readable (Default only). */
export const launchChoiceHasModels = (choices: InboxLaunchChoices) => choices.models.length > 0 || !!choices.reading || !!choices.unread;

/**
 * The button's words in three parts, so only the default's name gives way on a narrow line: "Default (" + name +
 * ") · high · build". Null when no named default shows (a model is picked, or the default is unknown).
 */
export function launchChoiceButtonParts(choice: InboxLaunchChoice, choices: InboxLaunchChoices): { lead: string; name: string; tail: string } | null {
  if (choice.model || !choices.default_model || !launchChoiceHasModels(choices)) return null;
  const rest = [choice.effort, choice.primary_agent].filter(Boolean).join(' · ');
  return { lead: 'Default (', name: shortLaunchModel(choices.default_model), tail: `)${rest ? ` · ${rest}` : ''}` };
}

export function launchChoiceButton(choice: InboxLaunchChoice, choices: InboxLaunchChoices): string {
  const parts = launchChoiceButtonParts(choice, choices);
  if (parts) return parts.lead + parts.name + parts.tail;
  const models = launchChoiceHasModels(choices);
  const fallback = models ? 'Default model' : `Default ${choices.effort_word.toLowerCase()}`;
  if (!choice.model && models) return choice.effort || choice.primary_agent ? ['Default model', choice.effort, choice.primary_agent].filter(Boolean).join(' · ') : fallback;
  return launchChoiceLine(choice, shortLaunchModel) ?? fallback;
}

/** The model menu's Default row: "Default", or with OpenCode's default "Default (big-pickle)" and its provider. */
export function launchDefaultRow(choices: InboxLaunchChoices): { name: string; provider: string | null } {
  const model = choices.default_model;
  if (!model) return { name: 'Default', provider: null };
  const at = model.indexOf('/');
  return { name: `Default (${shortLaunchModel(model)})`, provider: at > 0 ? model.slice(0, at) : null };
}

const UNREAD_WHY: Record<InboxLaunchChoicesUnread, string> = {
  timeout: 'it took longer than 5 seconds.',
  exit: 'OpenCode stopped with an error.',
  unreadable: "its answer wasn't readable.",
  missing: "the Inbox can't find opencode2.",
  not_started: "OpenCode didn't start.",
  empty: '',
};

/** The menu's one line when OpenCode's list could not be read (or is being read); null when it was read. */
export function launchChoiceNotice(choices: InboxLaunchChoices): string | null {
  if (choices.reading) return "Reading OpenCode's models…";
  if (!choices.unread) return null;
  if (choices.unread === 'empty') return 'OpenCode has no models set up.';
  // A code a newer Inbox sends that this window doesn't know reads as an error.
  return `Couldn't read OpenCode's models: ${UNREAD_WHY[choices.unread] || UNREAD_WHY.exit}`;
}

/** What the menu picks: "Model and variant", with OpenCode's agents "Model, variant and agent"; "Model" while there is no list. */
export function launchChoiceMenuName(choices: InboxLaunchChoices): string {
  if (choices.reading || choices.unread) return 'Model';
  const effort = choices.effort_word.toLowerCase();
  return choices.primary_agents?.length ? `Model, ${effort} and agent` : `Model and ${effort}`;
}

/** A full model name the CLI doesn't list (sent through the API) still shows as the last choice. */
export function launchModelRows(choice: InboxLaunchChoice, choices: InboxLaunchChoices): string[] {
  return choice.model && !choices.models.includes(choice.model) ? [...choices.models, choice.model] : choices.models;
}

/** Default sends nothing, so the agent's own CLI decides. */
export const launchChoiceSend = (choice: InboxLaunchChoice) => ({
  ...(choice.model ? { model: choice.model } : {}),
  ...(choice.effort ? { effort: choice.effort } : {}),
  ...(choice.primary_agent ? { primary_agent: choice.primary_agent } : {}),
});
