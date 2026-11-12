import { openItemsLabel } from './openQuestions';

export type OpenQuestionsLabelForm = 'full' | 'short' | 'count';

export const OPEN_QUESTIONS_LABEL_FORMS: readonly OpenQuestionsLabelForm[] = ['full', 'short', 'count'];

export function openQuestionsFormText(questions: number, form: OpenQuestionsLabelForm, actions = 0, permission = false, skip: number | null = null, answered = false): string {
  if (skip !== null && skip > 0) return form === 'count' ? String(skip) : `${skip} to skip`;
  const n = questions + actions;
  if (n === 0) return answered ? '' : 'Questions';
  if (form === 'count') return String(n);
  if (permission) return form === 'short' ? `${n} waiting` : `${n} permission${n === 1 ? '' : 's'} waiting`;
  if (form === 'short') return `${n} open`;
  return openItemsLabel(questions, actions);
}

export interface FootFit {
  form: OpenQuestionsLabelForm;
  tight: boolean;
}

export function footFitCandidates(max: OpenQuestionsLabelForm): FootFit[] {
  const forms = OPEN_QUESTIONS_LABEL_FORMS.slice(OPEN_QUESTIONS_LABEL_FORMS.indexOf(max));
  return forms.flatMap((form) => [
    { form, tight: false },
    { form, tight: true },
  ]);
}

export interface CardFootFit extends FootFit {
  fit: string;
}

export function cardFootFitCandidates(): CardFootFit[] {
  const count: FootFit = { form: 'count', tight: false };
  const rows = (forms: readonly FootFit[], fit: string) => forms.map((form) => ({ ...form, fit }));
  const words = footFitCandidates('full').filter((c) => !c.tight);
  return [...rows(words, ''), ...rows([count], 'chips'), ...rows([count], 'chips link'), ...rows(words, 'stack'), ...rows([count], 'stack chips'), ...rows([count], 'stack chips link wrap')];
}

export type FootFitWithSteps = FootFit & { steps: boolean };

export function footFitCandidatesWithSteps(max: OpenQuestionsLabelForm): FootFitWithSteps[] {
  const [first, ...rest] = footFitCandidates(max);
  return [{ ...first!, steps: false }, { ...first!, steps: true }, ...rest.map((fit) => ({ ...fit, steps: true }))];
}

export function drawStepsFit(buttons: HTMLElement, narrow: boolean): void {
  buttons.toggleAttribute('data-steps-fit', narrow);
}

export function onOneLine(tops: readonly number[]): boolean {
  return tops.every((top) => Math.abs(top - tops[0]!) <= 1);
}

export interface Span {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const overlaps = (a: Span, b: Span) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

export function pillHitsButtons(row: Span, pill: { width: number; height: number }, buttons: readonly Span[], margin = 8): boolean {
  const cx = (row.left + row.right) / 2;
  const cy = (row.top + row.bottom) / 2;
  const box: Span = {
    left: cx - pill.width / 2 - margin,
    right: cx + pill.width / 2 + margin,
    top: cy - pill.height / 2,
    bottom: cy + pill.height / 2,
  };
  return buttons.some((b) => b.right > b.left && overlaps(box, b));
}

export function laidOutChildren(row: Element): HTMLElement[] {
  return [...row.children].filter((el): el is HTMLElement => {
    if (!(el instanceof HTMLElement)) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.position !== 'absolute' && style.position !== 'fixed';
  });
}

function sameLineChildren(row: Element): HTMLElement[] {
  return laidOutChildren(row).filter((el) => getComputedStyle(el).flexBasis !== '100%');
}

export function fitFootRow<T>(buttons: HTMLElement, candidates: readonly T[], apply: (fit: T) => void, fits: () => boolean = () => true): T | null {
  if (buttons.getBoundingClientRect().width <= 0 || candidates.length === 0) return null;
  for (const fit of candidates) {
    apply(fit);
    if (onOneLine(sameLineChildren(buttons).map((el) => el.getBoundingClientRect().top)) && fits()) return fit;
  }
  return candidates[candidates.length - 1]!;
}

export type FootRowStep = 'keys' | 'edit' | 'steps' | 'oq' | 'draft' | 'tight';

export const FOOT_ROW_STEPS: readonly FootRowStep[] = ['keys', 'edit', 'steps', 'oq', 'draft', 'tight'];

export function footRowTokens(level: number): string {
  return FOOT_ROW_STEPS.slice(0, Math.max(0, level)).join(' ');
}

export function footRowOpenQuestionsForm(level: number, max: OpenQuestionsLabelForm): OpenQuestionsLabelForm {
  return level >= FOOT_ROW_STEPS.indexOf('oq') + 1 ? 'count' : max;
}

export function onOneRow(mids: readonly number[]): boolean {
  return mids.every((mid) => Math.abs(mid - mids[0]!) < 4);
}

function rowMids(row: Element): number[] {
  const parts = [...row.querySelectorAll<HTMLElement>('[data-foot-buttons], [data-foot-status]')].flatMap((group) => sameLineChildren(group));
  return parts
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0)
    .map((r) => r.top + r.height / 2);
}

export function drawOpenQuestionsForm(button: HTMLElement, fit: FootFit): void {
  const words = button.querySelector<HTMLElement>('[data-oq-words]');
  const n = Number(button.getAttribute('data-oq-n') ?? '0');
  const actions = Number(button.getAttribute('data-oq-actions') ?? '0');
  const permission = button.hasAttribute('data-oq-permission');
  const skip = button.hasAttribute('data-oq-skipping') ? Number(button.getAttribute('data-oq-skipping') || '0') : null;
  const skipping = skip !== null && skip > 0;
  const answered = button.hasAttribute('data-oq-answered');
  if (words) words.textContent = openQuestionsFormText(n, fit.form, actions, permission, skip, answered);
  button.setAttribute('data-label-form', fit.form);
  button.toggleAttribute('data-fit-tight', fit.tight);
  const label = button.getAttribute('data-oq-label');
  if ((fit.form === 'full' && !skipping && !answered) || !label) button.removeAttribute('aria-label');
  else button.setAttribute('aria-label', label);
}

export function fitWholeFootRowForms(row: HTMLElement): { level: number; max: OpenQuestionsLabelForm } | null {
  const level = fitWholeFootRow(row, 'full');
  return level === null ? null : { level, max: 'full' };
}

export function fitWholeFootRow(row: HTMLElement, max: OpenQuestionsLabelForm): number | null {
  if (row.getBoundingClientRect().width <= 0) return null;
  const button = row.querySelector<HTMLElement>('[data-foot-buttons] [data-open-questions]');
  const was = {
    fit: row.getAttribute('data-fit'),
    button: button
      ? { form: (button.getAttribute('data-label-form') ?? max) as OpenQuestionsLabelForm, tight: button.hasAttribute('data-fit-tight') }
      : null,
  };
  for (let level = 0; level <= FOOT_ROW_STEPS.length; level++) {
    const tokens = footRowTokens(level);
    if (tokens) row.setAttribute('data-fit', tokens);
    else row.removeAttribute('data-fit');
    if (button) drawOpenQuestionsForm(button, { form: footRowOpenQuestionsForm(level, max), tight: false });
    if (onOneRow(rowMids(row))) return level;
  }
  if (was.fit === null) row.removeAttribute('data-fit');
  else row.setAttribute('data-fit', was.fit);
  if (button && was.button) drawOpenQuestionsForm(button, was.button);
  return null;
}
