import { PLAN_WIDTH_OPTIONS, type PlanWidth } from '@plannotator/ui/utils/uiPreferences';

/**
 * The goal setup screen is a form, not a document, and it hides both side
 * panels, so it keeps each Plan Width choice's cap: Wide stays at 1280px
 * there instead of filling the whole window.
 */
export function goalSetupMaxWidth(width: PlanWidth): number {
  return (PLAN_WIDTH_OPTIONS.find((option) => option.id === width) ?? PLAN_WIDTH_OPTIONS[0]).px;
}
