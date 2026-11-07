/**
 * The "Diff display" popover behind a gear (approval "diff-controls-headers":
 * "The popover looks good"): how every diff is drawn, from the settings code
 * review keeps (`diff*` in the config store: a `plannotator-diff-*` cookie
 * and config.json `diffOptions`), so a choice made in one surface holds in
 * the others. Split / Unified is not here: the header's one button
 * (DiffLayoutToggle) sets it.
 *
 * Code review draws it in its dock strip (review-editor DiffOptionsPopover);
 * the Inbox in its review bars, without the two rows that need the local
 * repository (`repositoryOptions={false}`: Whole file, Hide whitespace).
 *
 * The option lists are this file's own, not Settings.tsx's, so a host that
 * draws only this popover does not load the settings dialog.
 */
import React from 'react';
import { Popover } from '@base-ui/react/popover';
import { configStore, useConfigValue } from '../config';
import type { SettingName } from '../config/settings';
import type { SettingValue } from '../config/configStore';
import { HostTitle } from './HostTitle';

/** The settings this popover writes. */
export type DiffDisplaySetting =
  | 'diffOverflow'
  | 'diffShowLineNumbers'
  | 'diffShowBackground'
  | 'diffLineBgIntensity'
  | 'diffIndicators'
  | 'diffLineDiffType'
  | 'diffTabSize'
  | 'diffExpandUnchanged'
  | 'diffHideWhitespace';

export type DiffDisplayChange = <K extends DiffDisplaySetting & SettingName>(key: K, value: SettingValue<K>) => void;

const INTENSITY = [
  { value: 'subtle' as const, label: 'Subtle' },
  { value: 'normal' as const, label: 'Normal' },
  { value: 'strong' as const, label: 'Strong' },
];
const LINE_DIFF = [
  { value: 'word-alt' as const, label: 'Word-Alt' },
  { value: 'word' as const, label: 'Word' },
  { value: 'char' as const, label: 'Char' },
  { value: 'none' as const, label: 'None' },
];
const MARK = 'w-3.5 h-3.5';
const INDICATORS = [
  {
    value: 'bars' as const,
    label: 'Bars',
    icon: (
      <svg className={MARK} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true">
        <path d="M2.5 2.5v11" strokeWidth={2.2} />
        <path d="M6 4.5h7.5M6 8h5.5M6 11.5h6.5" />
      </svg>
    ),
  },
  {
    value: 'classic' as const,
    label: 'Classic + and −',
    icon: (
      <svg className={MARK} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true">
        <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" />
        <path d="M5 6h6M8 3.5v5M5 11h6" />
      </svg>
    ),
  },
  {
    value: 'none' as const,
    label: 'None',
    icon: (
      <svg className={MARK} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" aria-hidden="true">
        <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" />
        <circle cx="8" cy="8" r="2" />
        <path d="M2.5 13.5l11-11" />
      </svg>
    ),
  },
];

function Segmented<T extends string>({ options, value, onChange, label, stretch = false }: {
  options: { value: T; label: string; icon?: React.ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  stretch?: boolean;
}) {
  return (
    <div role="group" aria-label={label} className={`${stretch ? 'flex' : 'inline-flex'} items-center gap-px bg-muted/60 rounded-md p-px`}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-pressed={value === opt.value}
          aria-label={opt.icon ? opt.label : undefined}
          title={opt.icon ? opt.label : undefined}
          onClick={() => onChange(opt.value)}
          className={`${stretch ? 'flex-1 px-1' : 'px-2'} inline-flex items-center justify-center min-w-7 py-1 text-[11.5px] whitespace-nowrap rounded-[5px] transition-colors ${
            value === opt.value ? 'bg-background text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {opt.icon ?? opt.label}
        </button>
      ))}
    </div>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="w-full flex items-center justify-between min-h-7 group">
      <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors">{label}</span>
      <span className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${checked ? 'bg-primary' : 'bg-muted-foreground/25'}`}>
        <span className={`inline-block h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
      </span>
    </button>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 min-h-7">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

export interface DiffDisplayOptionsPopoverProps {
  /** Whole file and Hide whitespace, which need the local repository. Default: shown (code review). */
  repositoryOptions?: boolean;
  /** Writes one setting. Default: the config store's `set`. */
  onChange?: DiffDisplayChange;
  /** The gear's classes. Default: code review's dock strip button. */
  triggerClassName?: string;
  /** The gear's content. Default: a gear icon. */
  triggerContent?: React.ReactNode;
  /** A phone-sized review: bigger targets in the popup (theme.css `[data-pn-compact-diff-options]`). */
  compactTouchLayout?: boolean;
  /** Where the gear's hover text opens when the host draws ui's tooltips (`componentTooltips`). Default: top. */
  triggerTitleSide?: 'top' | 'right' | 'bottom' | 'left';
}

const GEAR = (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);

export const DiffDisplayOptionsPopover: React.FC<DiffDisplayOptionsPopoverProps> = ({
  repositoryOptions = true,
  onChange,
  triggerClassName = 'px-2 py-1 rounded-md text-muted-foreground hover:text-foreground transition-colors flex items-center data-popup-open:bg-background data-popup-open:text-foreground data-popup-open:shadow-sm',
  triggerContent = GEAR,
  compactTouchLayout = false,
  triggerTitleSide = 'top',
}) => {
  const set: DiffDisplayChange = onChange ?? ((key, value) => configStore.set(key, value));
  const overflow = useConfigValue('diffOverflow');
  const indicators = useConfigValue('diffIndicators');
  const lineDiffType = useConfigValue('diffLineDiffType');
  const showLineNumbers = useConfigValue('diffShowLineNumbers');
  const showBackground = useConfigValue('diffShowBackground');
  const intensity = useConfigValue('diffLineBgIntensity');
  const tabSize = useConfigValue('diffTabSize');
  const expandUnchanged = useConfigValue('diffExpandUnchanged');
  const hideWhitespace = useConfigValue('diffHideWhitespace');
  const stepTab = (n: number) => set('diffTabSize', Math.max(1, Math.min(8, n)));

  return (
    <Popover.Root>
      {/* A native title by default (code review); ui's tooltip where the host opts in (the Inbox), like its neighbours. */}
      <HostTitle title="Diff display options" side={triggerTitleSide}>
        <Popover.Trigger
          render={
            <button
              type="button"
              data-pn-touch-target
              data-pn-touch-target-icon
              data-diff-display-options=""
              className={triggerClassName}
              aria-label="Diff display options"
            />
          }
        >
          {triggerContent}
        </Popover.Trigger>
      </HostTitle>
      <Popover.Portal>
        <Popover.Positioner align="end" sideOffset={6} className="z-50">
          <Popover.Popup
            aria-label="Diff display"
            data-pn-compact-diff-options={compactTouchLayout || undefined}
            data-diff-display-popup=""
            className="w-[min(18rem,calc(100vw-1rem))] max-h-[calc(var(--pn-viewport-height,100vh)-2rem-var(--pn-safe-top)-var(--pn-safe-bottom))] overflow-y-auto bg-popover text-popover-foreground border border-border rounded-lg shadow-lg origin-[var(--transform-origin)] transition-opacity data-starting-style:opacity-0 data-ending-style:opacity-0"
          >
            <div className="px-2.5 py-2">
              <Switch label="Wrap long lines" checked={overflow === 'wrap'} onChange={(v) => set('diffOverflow', v ? 'wrap' : 'scroll')} />
              <Switch label="Line numbers" checked={showLineNumbers} onChange={(v) => set('diffShowLineNumbers', v)} />
              <Switch label="Backgrounds" checked={showBackground} onChange={(v) => set('diffShowBackground', v)} />
              {showBackground && (
                <div className="flex justify-end pb-1">
                  <Segmented label="Background strength" options={INTENSITY} value={intensity} onChange={(v) => set('diffLineBgIntensity', v)} />
                </div>
              )}
              <div className="border-t border-border/60 my-1.5 -mx-2.5" />
              <Row label="Change marks">
                <Segmented label="Change marks" options={INDICATORS} value={indicators} onChange={(v) => set('diffIndicators', v)} />
              </Row>
              <div className="pt-1">
                <div className="text-xs text-muted-foreground mb-1">Changed words</div>
                <Segmented stretch label="Changed words" options={LINE_DIFF} value={lineDiffType} onChange={(v) => set('diffLineDiffType', v)} />
              </div>
              <Row label="Tab size">
                <div className="inline-flex items-center gap-px bg-muted/60 rounded-md p-px">
                  <button type="button" onClick={() => stepTab(tabSize - 1)} disabled={tabSize <= 1} aria-label="Decrease tab size" className="px-1.5 py-0.5 text-[11.5px] rounded-[5px] text-muted-foreground hover:text-foreground hover:bg-background disabled:opacity-40 disabled:hover:bg-transparent">−</button>
                  <span className="px-2 text-[11.5px] tabular-nums w-5 text-center" data-diff-tab-size={tabSize}>{tabSize}</span>
                  <button type="button" onClick={() => stepTab(tabSize + 1)} disabled={tabSize >= 8} aria-label="Increase tab size" className="px-1.5 py-0.5 text-[11.5px] rounded-[5px] text-muted-foreground hover:text-foreground hover:bg-background disabled:opacity-40 disabled:hover:bg-transparent">+</button>
                </div>
              </Row>
              {repositoryOptions && (
                <>
                  <div className="border-t border-border/60 my-1.5 -mx-2.5" />
                  <Switch label="Whole file" checked={expandUnchanged} onChange={(v) => set('diffExpandUnchanged', v)} />
                  <Switch label="Hide whitespace" checked={hideWhitespace} onChange={(v) => set('diffHideWhitespace', v)} />
                </>
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};
