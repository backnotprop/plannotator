/**
 * The controls Settings → Reviews draws with. `ReviewSettingsPage` never
 * styles a section, row, switch or segmented control itself: the host passes
 * them, so classic code review and the Inbox show the same page in their own
 * settings look. `CLASSIC_REVIEW_SETTINGS_CONTROLS` is classic code review's set.
 */
import React from 'react';
import { AnalysisLayerToggle } from '../AnalysisLayerToggle';

export type ReviewSettingsSectionId = 'display' | 'semantic' | 'powerUp' | 'callFlow' | 'packages' | 'files';

export interface ReviewSettingsSwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface ReviewSettingsRowProps {
  title: string;
  hint?: React.ReactNode;
  /** The row's control, drawn at the end of the row (below it when the row is narrow). */
  children?: React.ReactNode;
}

export interface ReviewSettingsSegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Drawn instead of the label; the label stays the accessible name. */
  icon?: React.ReactNode;
}

export interface ReviewSettingsSegmentedProps<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<ReviewSettingsSegmentedOption<T>>;
  onChange: (value: T) => void;
  disabled?: boolean;
}

export interface ReviewSettingsSectionProps {
  id: ReviewSettingsSectionId;
  title: string;
  description?: React.ReactNode;
  /** A section that is one feature: its title is that feature's switch. */
  toggle?: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; description?: string };
  /** The first section on the page (no rule above it). */
  first?: boolean;
  children?: React.ReactNode;
}

export interface ReviewSettingsControls {
  Section: React.ComponentType<ReviewSettingsSectionProps>;
  Row: React.ComponentType<ReviewSettingsRowProps>;
  Switch: React.ComponentType<ReviewSettingsSwitchProps>;
  Segmented: <T extends string>(props: ReviewSettingsSegmentedProps<T>) => React.ReactElement | null;
}

function ClassicSection({ id, title, description, toggle, first = false, children }: ReviewSettingsSectionProps) {
  const headingId = `review-settings-${id}`;
  return (
    <section aria-labelledby={headingId} className={first ? 'space-y-1' : 'space-y-1 border-t border-border pt-4'}>
      {toggle ? (
        <AnalysisLayerToggle
          checked={toggle.checked}
          onChange={toggle.onChange}
          disabled={toggle.disabled}
          label={<span id={headingId} className="font-semibold">{title}</span>}
          description={toggle.description ?? ''}
        />
      ) : (
        <div className="pb-1">
          <h3 id={headingId} className="text-sm font-semibold text-foreground">{title}</h3>
          {description && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>}
        </div>
      )}
      {children}
    </section>
  );
}

function ClassicRow({ title, hint, children }: ReviewSettingsRowProps) {
  return (
    <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-2 py-1">
      <div className="min-w-[10rem] flex-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {hint && <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{hint}</div>}
      </div>
      {children && <div className="max-w-full shrink-0">{children}</div>}
    </div>
  );
}

function ClassicSwitch({ checked, onChange, label, description, disabled }: ReviewSettingsSwitchProps) {
  return (
    <AnalysisLayerToggle checked={checked} onChange={onChange} label={label} description={description ?? ''} disabled={disabled} className="py-1" />
  );
}

function ClassicSegmented<T extends string>({ label, value, options, onChange, disabled = false }: ReviewSettingsSegmentedProps<T>) {
  return (
    <div
      className={`inline-flex max-w-full flex-wrap items-center gap-px rounded-md bg-muted/60 p-px ${disabled ? 'opacity-50' : ''}`}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          aria-label={opt.icon ? opt.label : undefined}
          title={opt.icon ? opt.label : undefined}
          disabled={disabled}
          onClick={() => onChange(opt.value)}
          className={`inline-flex min-w-7 items-center justify-center whitespace-nowrap rounded-[5px] px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed ${
            value === opt.value ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {opt.icon ?? opt.label}
        </button>
      ))}
    </div>
  );
}

export const CLASSIC_REVIEW_SETTINGS_CONTROLS: ReviewSettingsControls = {
  Section: ClassicSection,
  Row: ClassicRow,
  Switch: ClassicSwitch,
  Segmented: ClassicSegmented,
};
