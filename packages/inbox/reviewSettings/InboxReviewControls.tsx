/**
 * The controls Settings → Reviews draws with in the Inbox: code review's own
 * page (@plannotator/ui `ReviewSettingsPage`), in the Inbox's settings look.
 * A section is a group (`ib-sgroup`) with its rows in one card; a section that
 * is one feature has its switch as the card's first row, its title the row's
 * heading. A row is the Inbox's settings row (`ib-prow`): words first, the
 * control at its end, or under the words when they do not fit beside it (a
 * phone) and always for a `wide` row (a form). Switches are the Inbox's
 * (`ib-sw`), choices its segmented control (`ib-seg`), fields its key field
 * (`ib-vkey`). Styles: reviewSettings.css.
 */
import { useId } from 'react';
import {
  CLASSIC_REVIEW_SETTINGS_CONTROLS,
  type ReviewSettingsButtonProps,
  type ReviewSettingsControls,
  type ReviewSettingsFieldProps,
  type ReviewSettingsGroupProps,
  type ReviewSettingsNoteProps,
  type ReviewSettingsRowProps,
  type ReviewSettingsSectionProps,
  type ReviewSettingsSegmentedProps,
  type ReviewSettingsSelectProps,
  type ReviewSettingsSliderProps,
  type ReviewSettingsStepperProps,
  type ReviewSettingsSwitchProps,
  type ReviewSettingsTextFieldProps,
} from '@plannotator/ui/components/settings/reviewSettingsControls';
import { Switch } from '../components/SettingSwitch';

function Section({ id, title, description, toggle, first = false, children }: ReviewSettingsSectionProps) {
  const headingId = `ib-rs-${id}`;
  const className = first ? 'ib-sgroup ib-sgroup-first' : 'ib-sgroup';
  if (toggle) {
    return (
      <section className={className} aria-labelledby={headingId} data-rs-section={id}>
        <div className="ib-card">
          <div className="ib-prow ib-rs-head">
            <div className="ib-txt">
              <h2 className="ib-l" id={headingId}>
                {title}
              </h2>
              {toggle.description && <span className="ib-desc">{toggle.description}</span>}
            </div>
            <span className="ib-ctl">
              <Switch on={toggle.checked} labelledBy={headingId} disabled={toggle.disabled} onClick={() => toggle.onChange(!toggle.checked)} />
            </span>
          </div>
          {children}
        </div>
      </section>
    );
  }
  return (
    <section className={className} aria-labelledby={headingId} data-rs-section={id}>
      <h2 id={headingId}>{title}</h2>
      {description && <p>{description}</p>}
      <div className="ib-card">{children}</div>
    </section>
  );
}

function Row({ title, hint, wide = false, children }: ReviewSettingsRowProps) {
  return (
    <div className={wide ? 'ib-prow ib-rs-row ib-rs-wide' : 'ib-prow ib-rs-row'} data-review-settings-row={wide ? 'wide' : ''}>
      <div className="ib-txt">
        <span className="ib-l">{title}</span>
        {hint && <span className="ib-desc">{hint}</span>}
      </div>
      {children && <div className={wide ? 'ib-rs-full' : 'ib-ctl'}>{children}</div>}
    </div>
  );
}

function Group({ id, title, children }: ReviewSettingsGroupProps) {
  const headingId = `ib-rs-group-${id}`;
  return (
    <section className="ib-rs-group" aria-labelledby={headingId}>
      <h3 id={headingId}>{title}</h3>
      {children}
    </section>
  );
}

function SwitchRow({ checked, onChange, label, description, disabled }: ReviewSettingsSwitchProps) {
  const labelId = useId();
  return (
    <div className="ib-prow ib-rs-row">
      <div className="ib-txt">
        <span className="ib-l" id={labelId}>
          {label}
        </span>
        {description && <span className="ib-desc">{description}</span>}
      </div>
      <span className="ib-ctl">
        <Switch on={checked} labelledBy={labelId} disabled={disabled} onClick={() => onChange(!checked)} />
      </span>
    </div>
  );
}

function Segmented<T extends string>({ label, value, options, onChange, disabled = false }: ReviewSettingsSegmentedProps<T>) {
  const name = useId();
  return (
    <span className="ib-seg ib-rs-seg" role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} data-off={disabled ? '' : undefined}>
      {options.map((opt) => (
        <label key={opt.value} className="ib-seg-o" data-on={value === opt.value ? '' : undefined} title={opt.icon ? opt.label : undefined}>
          <input
            type="radio"
            name={name}
            value={opt.value}
            checked={value === opt.value}
            disabled={disabled}
            aria-label={opt.icon ? opt.label : undefined}
            onChange={() => onChange(opt.value)}
          />
          {opt.icon ?? opt.label}
        </label>
      ))}
    </span>
  );
}

function Select<T extends string>({ label, value, options, onChange, fontFamily }: ReviewSettingsSelectProps<T>) {
  return (
    <select className="ib-rs-select" aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)} style={fontFamily ? { fontFamily } : undefined}>
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

function Stepper({ label, value, min, max, onChange, decreaseLabel, increaseLabel }: ReviewSettingsStepperProps) {
  return (
    <span className="ib-seg ib-rs-step" role="group" aria-label={label}>
      <button type="button" className="ib-seg-o" onClick={() => onChange(value - 1)} disabled={value <= min} aria-label={decreaseLabel}>
        −
      </button>
      <span className="ib-rs-stepv" data-diff-tab-size={value}>
        {value}
      </span>
      <button type="button" className="ib-seg-o" onClick={() => onChange(value + 1)} disabled={value >= max} aria-label={increaseLabel}>
        +
      </button>
    </span>
  );
}

function Slider({ label, value, min, max, onChange, valueText, reset }: ReviewSettingsSliderProps) {
  return (
    <span className="ib-rs-slider">
      <input type="range" className="ib-rs-range" min={min} max={max} step={1} aria-label={label} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="ib-rs-val">{valueText}</span>
      {reset && (
        <button type="button" className="ib-btn ib-sm ib-ghost" onClick={reset.onReset}>
          {reset.label}
        </button>
      )}
    </span>
  );
}

function TextField(props: ReviewSettingsTextFieldProps) {
  // A long value that wraps (an endpoint URL) keeps code review's own field: it grows with its value and Enter still submits.
  if (props.wrap && !props.secret) return <CLASSIC_REVIEW_SETTINGS_CONTROLS.TextField {...props} />;
  const { label, value, onChange, placeholder, secret = false, mono = false, invalid = false, describedBy, onFocus, fontFamily, autoFocus, maxLength } = props;
  return (
    <input
      className={mono ? 'ib-vkey ib-rs-text' : 'ib-vkey ib-rs-text ib-rs-sans'}
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

function Field({ caption, labelsControl = true, children }: ReviewSettingsFieldProps) {
  const Tag = labelsControl ? 'label' : 'div';
  return (
    <Tag className="ib-rs-field">
      <span className="ib-rs-cap">{caption}</span>
      {children}
    </Tag>
  );
}

function Button(props: ReviewSettingsButtonProps) {
  return <button type="button" {...props} className="ib-btn ib-sm" />;
}

function Note({ tone = 'muted', ...rest }: ReviewSettingsNoteProps) {
  return <span {...rest} className="ib-rs-note" data-tone={tone} />;
}

export const INBOX_REVIEW_SETTINGS_CONTROLS: ReviewSettingsControls = {
  Section,
  Row,
  Group,
  Switch: SwitchRow,
  Segmented,
  Select,
  Stepper,
  Slider,
  TextField,
  Field,
  Button,
  Note,
};
