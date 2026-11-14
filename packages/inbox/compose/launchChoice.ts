import { launchChoiceLine, launchEffortsFor, type InboxLaunchChoice, type InboxLaunchChoices } from '@plannotator/core/inbox-launch-choice';

/** An effort the CLI no longer lists is dropped. */
export function initialLaunchChoice(choices: InboxLaunchChoices | null | undefined): InboxLaunchChoice {
  const last = choices?.last;
  if (!choices || !last) return {};
  return { ...(last.model ? { model: last.model } : {}), ...(last.effort && launchEffortsFor(choices, last.model).includes(last.effort) ? { effort: last.effort } : {}) };
}

export function pickLaunchModel(choice: InboxLaunchChoice, choices: InboxLaunchChoices, model: string | null): InboxLaunchChoice {
  const next: InboxLaunchChoice = model ? { model } : {};
  if (choice.effort && launchEffortsFor(choices, next.model).includes(choice.effort)) next.effort = choice.effort;
  return next;
}

export const shortLaunchModel = (model: string) => model.slice(model.lastIndexOf('/') + 1);

export function launchChoiceButton(choice: InboxLaunchChoice, choices: InboxLaunchChoices): string {
  const fallback = choices.models.length > 0 ? 'Default model' : `Default ${choices.effort_word.toLowerCase()}`;
  if (!choice.model && choices.models.length > 0) return choice.effort ? `Default model · ${choice.effort}` : fallback;
  return launchChoiceLine(choice, shortLaunchModel) ?? fallback;
}

/** A full model name the CLI doesn't list (sent through the API) still shows as the last choice. */
export function launchModelRows(choice: InboxLaunchChoice, choices: InboxLaunchChoices): string[] {
  return choice.model && !choices.models.includes(choice.model) ? [...choices.models, choice.model] : choices.models;
}

/** Default sends nothing, so the agent's own CLI decides. */
export const launchChoiceSend = (choice: InboxLaunchChoice) => ({ ...(choice.model ? { model: choice.model } : {}), ...(choice.effort ? { effort: choice.effort } : {}) });
