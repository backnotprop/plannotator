import React from 'react';
import * as Popover from '@radix-ui/react-popover';
import { configStore, useConfigValue } from '@plannotator/ui/config';
import {
  DIFF_STYLE_OPTIONS,
  OVERFLOW_OPTIONS,
  INDICATOR_OPTIONS,
  LINE_DIFF_OPTIONS,
} from '@plannotator/ui/components/Settings';

function CompactSegmented<T extends string>({ options, value, onChange }: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-px bg-muted/60 rounded-md p-px">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`flex-1 px-2 py-1 text-[11px] rounded-[5px] transition-colors ${
            value === opt.value
              ? 'bg-background text-foreground shadow-sm font-medium'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function CompactStepper({ value, min, max, onChange, label }: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  label: string;
}) {
  const clamp = (n: number) => Math.max(min, Math.min(max, n));
  return (
    <div className="w-full flex items-center justify-between py-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <div className="flex items-center gap-px bg-muted/60 rounded-md p-px">
        <button
          onClick={() => onChange(clamp(value - 1))}
          disabled={value <= min}
          className="px-1.5 py-0.5 text-[11px] rounded-[5px] text-muted-foreground hover:text-foreground hover:bg-background disabled:opacity-40 disabled:hover:bg-transparent"
          aria-label={`Decrease ${label}`}
        >−</button>
        <span className="px-2 text-[11px] tabular-nums w-5 text-center">{value}</span>
        <button
          onClick={() => onChange(clamp(value + 1))}
          disabled={value >= max}
          className="px-1.5 py-0.5 text-[11px] rounded-[5px] text-muted-foreground hover:text-foreground hover:bg-background disabled:opacity-40 disabled:hover:bg-transparent"
          aria-label={`Increase ${label}`}
        >+</button>
      </div>
    </div>
  );
}

function CompactToggle({ checked, onChange, label }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="w-full flex items-center justify-between py-1 group"
    >
      <span className="text-[11px] text-muted-foreground group-hover:text-foreground transition-colors">{label}</span>
      <span className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
        checked ? 'bg-primary' : 'bg-muted-foreground/25'
      }`}>
        <span className={`inline-block h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-3.5' : 'translate-x-0.5'
        }`} />
      </span>
    </button>
  );
}

export const DiffOptionsPopover: React.FC = () => {
  const diffStyle = useConfigValue('diffStyle');
  const diffOverflow = useConfigValue('diffOverflow');
  const diffIndicators = useConfigValue('diffIndicators');
  const diffLineDiffType = useConfigValue('diffLineDiffType');
  const diffShowLineNumbers = useConfigValue('diffShowLineNumbers');
  const diffShowBackground = useConfigValue('diffShowBackground');
  const diffHideWhitespace = useConfigValue('diffHideWhitespace');
  const diffTabSize = useConfigValue('diffTabSize');

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          className="text-xs text-muted-foreground hover:text-foreground rounded hover:bg-muted transition-colors flex items-center px-1.5 py-1"
          title="Diff display options"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-50 w-72 bg-popover text-popover-foreground border border-border rounded-lg shadow-lg overflow-hidden origin-[var(--radix-popover-content-transform-origin)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        >
          <div className="p-2.5 space-y-2">
            <div className="space-y-1.5">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mb-1">Layout</div>
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <CompactSegmented options={DIFF_STYLE_OPTIONS} value={diffStyle} onChange={(v) => configStore.set('diffStyle', v)} />
                  </div>
                  <div className="w-px h-5 bg-border/50 flex-shrink-0" />
                  <div className="flex-1">
                    <CompactSegmented options={OVERFLOW_OPTIONS} value={diffOverflow} onChange={(v) => configStore.set('diffOverflow', v)} />
                  </div>
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mb-1">Indicators</div>
                <CompactSegmented options={INDICATOR_OPTIONS} value={diffIndicators} onChange={(v) => configStore.set('diffIndicators', v)} />
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mb-1">Inline diff</div>
                <CompactSegmented options={LINE_DIFF_OPTIONS} value={diffLineDiffType} onChange={(v) => configStore.set('diffLineDiffType', v)} />
              </div>
            </div>

            <div className="border-t border-border/50" />

            <div>
              <CompactToggle checked={diffShowLineNumbers} onChange={(v) => configStore.set('diffShowLineNumbers', v)} label="Line numbers" />
              <CompactToggle checked={diffShowBackground} onChange={(v) => configStore.set('diffShowBackground', v)} label="Diff background" />
              <CompactToggle checked={diffHideWhitespace} onChange={(v) => configStore.set('diffHideWhitespace', v)} label="Hide whitespace" />
              <CompactStepper
                label="Tab size"
                value={diffTabSize}
                min={1}
                max={8}
                onChange={(v) => configStore.set('diffTabSize', v)}
              />
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};
