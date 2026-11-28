/**
 * The controls Settings → Reviews draws with. `ReviewSettingsPage` never
 * styles a control itself: the host passes every one (section, row, group,
 * switch, segmented control, select, stepper, slider, text field, field
 * caption, button, note), so classic code review and the Inbox show the same
 * page in their own settings look. `CLASSIC_REVIEW_SETTINGS_CONTROLS` is
 * classic code review's set; a host can spread it and replace only some.
 *
 * Classic's rows follow one rule: in a section narrower than 26rem every row
 * puts its control under its title; wider, every control sits at the row's
 * end. A `wide` row (a form) always puts it underneath, at full width.
 */
import React from 'react';
import { configStore } from '../../config';
import type { SettingName } from '../../config/settings';
import type { SettingValue } from '../../config/configStore';
import { AnalysisLayerToggle } from '../AnalysisLayerToggle';

export type ReviewSettingsSectionId = 'display' | 'semantic' | 'powerUp' | 'callFlow' | 'packages' | 'files';

/**
 * Writes one setting. A host routes the page's writes through it (the Inbox
 * also saves diff options to its own settings route); the default writes the
 * config store, like code review's gear.
 */
export type ReviewSettingChange = <K extends SettingName>(key: K, value: SettingValue<K>) => void;
export const writeReviewSettingToStore: ReviewSettingChange = (key, value) => configStore.set(key, value);

/**
 * The rows a host can honour. Each defaults to shown; a host turns off a row
 * whose setting it does not apply (the Inbox has no minimap, no whitespace
 * hiding, no hover cards, no local default diff, no viewed marks to set by
 * scrolling and no Call flow).
 */
export interface ReviewSettingsRows {
  /** Hide whitespace (needs the local repository). */
  hideWhitespace: boolean;
  /** Minimap (needs the diff overview strip). */
  minimap: boolean;
  /** Hover cards and their delay (need ripgrep and a local checkout). */
  hoverCards: boolean;
  /** Files and defaults' Git and Jujutsu groups: default file grouping and default diff view. */
  defaultDiffViews: boolean;
  /** Files and defaults' Auto-mark viewed (needs code review's viewed marks). With no default diff views either, the section is not drawn. */
  autoViewed: boolean;
  /** The Call flow section (needs code review's server and a local checkout). */
  callFlow: boolean;
}

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
  /** The control is a form or a full-width field: always draw it under the title, at full width. */
  wide?: boolean;
  /** The row's control. */
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

/** A titled group of rows inside a section (Git, Jujutsu). `id` names it for `aria-labelledby`. */
export interface ReviewSettingsGroupProps {
  id: string;
  title: string;
  children?: React.ReactNode;
}

export interface ReviewSettingsSelectProps<T extends string> {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  /** Draw the select in this `font-family` (a font preview). */
  fontFamily?: string;
}

export interface ReviewSettingsStepperProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  decreaseLabel: string;
  increaseLabel: string;
}

export interface ReviewSettingsSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  /** The value as words, beside the slider ("13px", "Auto"). */
  valueText: string;
  /** A button that clears the value back to its default; omitted while it is the default. */
  reset?: { label: string; onReset: () => void };
}

export interface ReviewSettingsTextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  secret?: boolean;
  /** Code-like values (keys, URLs, model names). */
  mono?: boolean;
  /**
   * A long value that must stay readable (an endpoint URL): it wraps onto more
   * lines instead of running out of the field. Still one value: Enter submits
   * the form, and line breaks are never typed into it.
   */
  wrap?: boolean;
  invalid?: boolean;
  describedBy?: string;
  onFocus?: () => void;
  fontFamily?: string;
  autoFocus?: boolean;
  maxLength?: number;
}

/** A small caption over one control (Endpoint URL, Auth). */
export interface ReviewSettingsFieldProps {
  caption: string;
  /** The caption labels a single text field inside (clicking it focuses the field). Default true. */
  labelsControl?: boolean;
  children?: React.ReactNode;
}

export type ReviewSettingsButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'style'>;

/** A line of small text: a caveat, a status, a field's message. */
export interface ReviewSettingsNoteProps extends Omit<React.HTMLAttributes<HTMLElement>, 'className' | 'style'> {
  tone?: 'muted' | 'warning' | 'success';
}

export interface ReviewSettingsControls {
  Section: React.ComponentType<ReviewSettingsSectionProps>;
  Row: React.ComponentType<ReviewSettingsRowProps>;
  Group: React.ComponentType<ReviewSettingsGroupProps>;
  Switch: React.ComponentType<ReviewSettingsSwitchProps>;
  Segmented: <T extends string>(props: ReviewSettingsSegmentedProps<T>) => React.ReactElement | null;
  Select: <T extends string>(props: ReviewSettingsSelectProps<T>) => React.ReactElement | null;
  Stepper: React.ComponentType<ReviewSettingsStepperProps>;
  Slider: React.ComponentType<ReviewSettingsSliderProps>;
  TextField: React.ComponentType<ReviewSettingsTextFieldProps>;
  Field: React.ComponentType<ReviewSettingsFieldProps>;
  Button: React.ComponentType<ReviewSettingsButtonProps>;
  Note: React.ComponentType<ReviewSettingsNoteProps>;
}

function ClassicSection({ id, title, description, toggle, first = false, children }: ReviewSettingsSectionProps) {
  const headingId = `review-settings-${id}`;
  return (
    <section
      aria-labelledby={headingId}
      className={`@container/review-settings ${first ? 'space-y-1' : 'space-y-1 border-t border-border pt-4'}`}
    >
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

const ROW_INLINE =
  '@min-[26rem]/review-settings:flex-row @min-[26rem]/review-settings:items-center @min-[26rem]/review-settings:justify-between @min-[26rem]/review-settings:gap-4';

function ClassicRow({ title, hint, wide = false, children }: ReviewSettingsRowProps) {
  return (
    <div className={`flex min-h-11 flex-col justify-center gap-2 py-1 ${wide ? '' : ROW_INLINE}`} data-review-settings-row={wide ? 'wide' : ''}>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {hint && <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{hint}</div>}
      </div>
      {children && <div className={wide ? 'w-full' : 'max-w-full @min-[26rem]/review-settings:shrink-0'}>{children}</div>}
    </div>
  );
}

function ClassicGroup({ id, title, children }: ReviewSettingsGroupProps) {
  const headingId = `settings-review-${id}`;
  return (
    <section aria-labelledby={headingId} className="pt-2">
      <h4 id={headingId} className="text-sm font-semibold text-foreground">{title}</h4>
      {children}
    </section>
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

const FIELD = 'h-8 w-full min-w-0 rounded-md border bg-background px-2.5 text-sm text-foreground outline-none';
const FIELD_RING = 'border-border focus:ring-1 focus:ring-ring';
const FIELD_INVALID = 'border-warning ring-1 ring-warning focus:ring-2 focus:ring-warning';

function ClassicSelect<T extends string>({ label, value, options, onChange, fontFamily }: ReviewSettingsSelectProps<T>) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className={`${FIELD} ${FIELD_RING} px-2`}
      style={fontFamily ? { fontFamily } : undefined}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  );
}

function ClassicStepper({ label, value, min, max, onChange, decreaseLabel, increaseLabel }: ReviewSettingsStepperProps) {
  const btn = 'h-6 px-2 text-xs rounded-[5px] text-muted-foreground hover:text-foreground hover:bg-background disabled:opacity-40 disabled:hover:bg-transparent';
  return (
    <div className="inline-flex items-center gap-px rounded-md bg-muted/60 p-px" role="group" aria-label={label}>
      <button type="button" onClick={() => onChange(value - 1)} disabled={value <= min} aria-label={decreaseLabel} className={btn}>−</button>
      <span className="w-6 text-center text-xs tabular-nums" data-diff-tab-size={value}>{value}</span>
      <button type="button" onClick={() => onChange(value + 1)} disabled={value >= max} aria-label={increaseLabel} className={btn}>+</button>
    </div>
  );
}

function ClassicSlider({ label, value, min, max, onChange, valueText, reset }: ReviewSettingsSliderProps) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 min-w-0 flex-1 cursor-pointer accent-primary"
      />
      <span className="min-w-[4ch] text-right text-xs tabular-nums text-muted-foreground">{valueText}</span>
      {reset && (
        <button type="button" onClick={reset.onReset} className="text-xs text-muted-foreground transition-colors hover:text-foreground">
          {reset.label}
        </button>
      )}
    </div>
  );
}

/** The height that shows every line of a textarea (its border included). */
function fitHeight(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
}

/**
 * A text field whose long value wraps (an endpoint URL in a narrow window):
 * one line looks like any other field; a longer value grows the field so all
 * of it, host first, stays in view.
 */
function ClassicWrapField({ label, value, onChange, placeholder, mono = false, invalid = false, describedBy, onFocus, fontFamily, autoFocus, maxLength }: ReviewSettingsTextFieldProps) {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  React.useLayoutEffect(() => {
    if (ref.current) fitHeight(ref.current);
  }, [value]);
  // Refit when the window changes the field's width (never on its own height change).
  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fitHeight(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <textarea
      ref={ref}
      rows={1}
      className={`block min-h-8 w-full min-w-0 resize-none overflow-hidden rounded-md border bg-background px-2.5 py-[7px] leading-4 text-foreground outline-none [overflow-wrap:anywhere] ${invalid ? FIELD_INVALID : FIELD_RING} placeholder:text-muted-foreground/60 ${mono ? 'font-mono text-xs' : 'text-sm'}`}
      style={fontFamily ? { fontFamily } : undefined}
      autoComplete="off"
      spellCheck={false}
      placeholder={placeholder}
      value={value}
      // One value: a pasted line break is dropped, and Enter submits the form like any other field.
      onChange={(e) => onChange(e.target.value.replace(/[\r\n]+/g, ''))}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
        e.preventDefault();
        e.currentTarget.form?.requestSubmit();
      }}
      onFocus={onFocus}
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      autoFocus={autoFocus}
      maxLength={maxLength}
    />
  );
}

function ClassicTextField(props: ReviewSettingsTextFieldProps) {
  if (props.wrap && !props.secret) return <ClassicWrapField {...props} />;
  const { label, value, onChange, placeholder, secret = false, mono = false, invalid = false, describedBy, onFocus, fontFamily, autoFocus, maxLength } = props;
  return (
    <input
      className={`${FIELD} ${invalid ? FIELD_INVALID : FIELD_RING} placeholder:text-muted-foreground/60 ${mono ? 'font-mono text-xs' : ''}`}
      style={fontFamily ? { fontFamily } : undefined}
      type={secret ? 'password' : 'text'}
      autoComplete="off"
      spellCheck={false}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={onFocus}
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      autoFocus={autoFocus}
      maxLength={maxLength}
    />
  );
}

function ClassicField({ caption, labelsControl = true, children }: ReviewSettingsFieldProps) {
  const Tag = labelsControl ? 'label' : 'div';
  return (
    <Tag className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-foreground">{caption}</span>
      {children}
    </Tag>
  );
}

function ClassicButton(props: ReviewSettingsButtonProps) {
  return (
    <button
      type="button"
      {...props}
      className="h-8 shrink-0 whitespace-nowrap rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
    />
  );
}

const NOTE_TONE = { muted: 'text-muted-foreground', warning: 'text-warning', success: 'text-success' } as const;

function ClassicNote({ tone = 'muted', ...rest }: ReviewSettingsNoteProps) {
  return <span {...rest} className={`block text-xs leading-relaxed ${NOTE_TONE[tone]}`} />;
}

export const CLASSIC_REVIEW_SETTINGS_CONTROLS: ReviewSettingsControls = {
  Section: ClassicSection,
  Row: ClassicRow,
  Group: ClassicGroup,
  Switch: ClassicSwitch,
  Segmented: ClassicSegmented,
  Select: ClassicSelect,
  Stepper: ClassicStepper,
  Slider: ClassicSlider,
  TextField: ClassicTextField,
  Field: ClassicField,
  Button: ClassicButton,
  Note: ClassicNote,
};
