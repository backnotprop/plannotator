import React, { useState } from 'react';
import {
  getUIPreferences,
  saveUIPreferences,
  PLAN_WIDTH_OPTIONS,
  type UIPreferences,
  type PlanWidth,
} from '../../utils/uiPreferences';
import { configStore, useConfigValue } from '../../config';
import { ToggleSwitch } from './shared';

interface PlanDisplayTabProps {
  onUIPreferencesChange?: (prefs: UIPreferences) => void;
}

export const PlanDisplayTab: React.FC<PlanDisplayTabProps> = ({ onUIPreferencesChange }) => {
  const taterMode = useConfigValue('taterMode');
  const [uiPrefs, setUiPrefs] = useState<UIPreferences>(() => getUIPreferences());

  const handleChange = (updates: Partial<UIPreferences>) => {
    const next = { ...uiPrefs, ...updates };
    setUiPrefs(next);
    saveUIPreferences(next);
    onUIPreferencesChange?.(next);
  };

  const active = PLAN_WIDTH_OPTIONS.find((o) => o.id === uiPrefs.planWidth) ?? PLAN_WIDTH_OPTIONS[0];
  const cardPctMap: Record<PlanWidth, number> = { compact: 48, default: 70, wide: 94 };

  return (
    <div className="space-y-5">
      <ToggleSwitch
        checked={uiPrefs.tocEnabled}
        onChange={(v) => handleChange({ tocEnabled: v })}
        label="Auto-open Sidebar"
        description="Open sidebar with Table of Contents on load"
      />

      <div className="border-t border-border" />

      <ToggleSwitch
        checked={uiPrefs.stickyActionsEnabled}
        onChange={(v) => handleChange({ stickyActionsEnabled: v })}
        label="Sticky Actions"
        description="Keep action buttons visible while scrolling"
      />

      <div className="border-t border-border" />

      <div className="space-y-3">
        <div>
          <div className="text-sm font-medium">Plan Width</div>
          <div className="text-xs text-muted-foreground">Maximum width of the plan card</div>
        </div>
        <div className="flex items-center gap-1 bg-muted/50 rounded-lg p-0.5">
          {PLAN_WIDTH_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => handleChange({ planWidth: opt.id })}
              className={`flex-1 px-3 py-1.5 text-xs rounded-md ${
                uiPrefs.planWidth === opt.id
                  ? 'bg-background text-foreground shadow-sm font-medium'
                  : 'text-foreground/70 hover:text-foreground'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="rounded-lg border border-border/40 bg-muted/20 px-2 py-3 overflow-hidden">
          <div className="flex items-center justify-between mb-2 px-1">
            <div className="h-0.5 w-8 rounded-full bg-foreground/15" />
            <div className="flex gap-1">
              <div className="h-1 w-1 rounded-full bg-foreground/15" />
              <div className="h-1 w-1 rounded-full bg-foreground/15" />
            </div>
          </div>
          <div className="border-t border-foreground/5 mb-2" />
          <div className="flex gap-1 items-stretch" style={{ minHeight: 64 }}>
            <div className="flex-shrink-0 space-y-1 pt-0.5 opacity-30" style={{ width: '14%' }}>
              <div className="h-0.5 w-full rounded-full bg-foreground" />
              <div className="h-0.5 w-3/4 rounded-full bg-foreground" />
              <div className="h-0.5 w-1/2 rounded-full bg-foreground" />
            </div>
            <div className="flex-1 flex justify-center min-w-0">
              <div
                className="rounded border border-border/60 bg-card/50 p-1.5 space-y-1"
                style={{ width: `${cardPctMap[active.id]}%`, minWidth: 0, transition: 'width 300ms ease-out' }}
              >
                <div className="h-1 w-2/5 rounded-full bg-foreground/25" />
                <div className="space-y-[2px]">
                  <div className="h-[2px] w-full rounded-full bg-foreground/10" />
                  <div className="h-[2px] w-11/12 rounded-full bg-foreground/10" />
                  <div className="h-[2px] w-4/5 rounded-full bg-foreground/10" />
                </div>
                <div className="rounded bg-muted/60 p-1 space-y-[2px]">
                  <div className="h-[2px] w-full rounded-full bg-primary/20" />
                  <div className="h-[2px] w-3/4 rounded-full bg-primary/20" />
                </div>
              </div>
            </div>
            <div className="flex-shrink-0 space-y-1 pt-0.5 opacity-20" style={{ width: '14%' }}>
              <div className="rounded border border-foreground/20 p-0.5 space-y-[2px]">
                <div className="h-[2px] w-full rounded-full bg-foreground" />
                <div className="h-[2px] w-2/3 rounded-full bg-foreground" />
              </div>
            </div>
          </div>
        </div>
        <div className="text-[10px] text-muted-foreground">
          {active.px}px — {active.hint}
        </div>
      </div>

      <div className="border-t border-border" />
      <ToggleSwitch
        checked={taterMode}
        onChange={(v) => configStore.set('taterMode', v)}
        label="Tater Mode"
      />
    </div>
  );
};
