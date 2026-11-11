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

/** What a launch will start with: the choice, field by field, else that machine's Settings default. */
export function effectiveLaunchChoice(choice: InboxLaunchChoice, choices: InboxLaunchChoices): InboxLaunchChoice {
  const model = choice.model ?? choices.default?.model;
  const effort = choice.effort ?? choices.default?.effort;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

/** The button's words: "opus · high", "Default model · high", or "Default model" ("Default thinking" with no Model menu). */
export function launchChoiceButton(choice: InboxLaunchChoice, choices: InboxLaunchChoices): string {
  const shown = effectiveLaunchChoice(choice, choices);
  const fallback = choices.models.length > 0 ? 'Default model' : `Default ${choices.effort_word.toLowerCase()}`;
  if (!shown.model && choices.models.length > 0) return shown.effort ? `Default model · ${shown.effort}` : fallback;
  return launchChoiceLine(shown, shortLaunchModel) ?? fallback;
}

/** The models the menu lists: the CLI's, then the choice or the default when the CLI doesn't list it (a full name). */
export function launchModelRows(choice: InboxLaunchChoice, choices: InboxLaunchChoices): string[] {
  const extra = [choice.model, choices.default?.model].filter((m): m is string => !!m && !choices.models.includes(m));
  return [...choices.models, ...new Set(extra)];
}

/** What a Send adds to `to.launch`: only what the person chose (the default is the server's). */
export const launchChoiceSend = (choice: InboxLaunchChoice) => ({ ...(choice.model ? { model: choice.model } : {}), ...(choice.effort ? { effort: choice.effort } : {}) });
