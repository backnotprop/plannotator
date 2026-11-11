/**
 * Compose's Model and Effort for a new session (docs/agent-guides/inbox-launch.md "Model and effort"): where the menu
 * starts, what its button says, and what a Send carries. The lists and the last choice come from the machine that
 * starts the agent (its launch block's `choices`); the server checks every value again.
 */
import { launchChoiceLine, type InboxLaunchChoice, type InboxLaunchChoices } from '@plannotator/core/inbox-launch-choice';

/** Where the menu starts: the last choice sent to this agent on that machine, an effort it no longer lists dropped. */
export function initialLaunchChoice(choices: InboxLaunchChoices | null | undefined): InboxLaunchChoice {
  const last = choices?.last;
  if (!choices || !last) return {};
  return { ...(last.model ? { model: last.model } : {}), ...(last.effort && choices.efforts.includes(last.effort) ? { effort: last.effort } : {}) };
}

/** A model as the menu and button show it: Pi's `provider/model` without its provider. */
export const shortLaunchModel = (model: string) => model.slice(model.lastIndexOf('/') + 1);

/** The button's words: "opus · high", "Default model · high", or "Default model" ("Default thinking" with no Model menu). */
export function launchChoiceButton(choice: InboxLaunchChoice, choices: InboxLaunchChoices): string {
  const fallback = choices.models.length > 0 ? 'Default model' : `Default ${choices.effort_word.toLowerCase()}`;
  if (!choice.model && choices.models.length > 0) return choice.effort ? `Default model · ${choice.effort}` : fallback;
  return launchChoiceLine(choice, shortLaunchModel) ?? fallback;
}

/** The models the menu lists: the CLI's, then the choice when the CLI doesn't list it (a full name, from the last Send). */
export function launchModelRows(choice: InboxLaunchChoice, choices: InboxLaunchChoices): string[] {
  return choice.model && !choices.models.includes(choice.model) ? [...choices.models, choice.model] : choices.models;
}

/** What a Send adds to `to.launch`: only what the person chose (Default: nothing, the agent's own CLI decides). */
export const launchChoiceSend = (choice: InboxLaunchChoice) => ({ ...(choice.model ? { model: choice.model } : {}), ...(choice.effort ? { effort: choice.effort } : {}) });
