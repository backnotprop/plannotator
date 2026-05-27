import React, { useState } from 'react';
import {
  getPlanSaveSettings,
  savePlanSaveSettings,
  type PlanSaveSettings,
} from '../../utils/planSave';
import {
  getDefaultNotesApp,
  saveDefaultNotesApp,
  type DefaultNotesApp,
} from '../../utils/defaultNotesApp';
import { getObsidianSettings, getEffectiveVaultPath } from '../../utils/obsidian';
import { getBearSettings } from '../../utils/bear';
import { getOctarineSettings } from '../../utils/octarine';
import { isMac } from '../../utils/platform';
import { ToggleSwitch } from './shared';
import { useEffect } from 'react';

const modKey = isMac ? '⌘' : 'Ctrl';

interface SavingTabProps {
  onNavigateTab?: (tabId: string) => void;
}

export const SavingTab: React.FC<SavingTabProps> = ({ onNavigateTab }) => {
  const [planSave, setPlanSave] = useState<PlanSaveSettings>(() => getPlanSaveSettings());
  const [defaultNotesApp, setDefaultNotesApp] = useState<DefaultNotesApp>(() => getDefaultNotesApp());

  const obsidian = getObsidianSettings();
  const bear = getBearSettings();
  const octarine = getOctarineSettings();
  const obsidianAvailable = obsidian.enabled && getEffectiveVaultPath(obsidian).trim().length > 0;
  const bearAvailable = bear.enabled;
  const octarineAvailable = octarine.enabled && (octarine.workspace?.trim().length ?? 0) > 0;

  useEffect(() => {
    if (defaultNotesApp === 'obsidian' && !obsidianAvailable) handleDefaultNotesAppChange('ask');
    else if (defaultNotesApp === 'bear' && !bearAvailable) handleDefaultNotesAppChange('ask');
    else if (defaultNotesApp === 'octarine' && !octarineAvailable) handleDefaultNotesAppChange('ask');
  }, [defaultNotesApp, obsidianAvailable, bearAvailable, octarineAvailable]);

  const handlePlanSaveChange = (updates: Partial<PlanSaveSettings>) => {
    const next = { ...planSave, ...updates };
    setPlanSave(next);
    savePlanSaveSettings(next);
  };

  const handleDefaultNotesAppChange = (app: DefaultNotesApp) => {
    setDefaultNotesApp(app);
    saveDefaultNotesApp(app);
  };

  return (
    <div className="space-y-5">
      <ToggleSwitch
        checked={planSave.enabled}
        onChange={(v) => handlePlanSaveChange({ enabled: v })}
        label="Save Plans"
        description="Auto-save plans to ~/.plannotator/plans/"
      />

      {planSave.enabled && (
        <div className="space-y-1.5 pl-0.5">
          <label className="text-xs text-muted-foreground">Custom Path (optional)</label>
          <input
            type="text"
            value={planSave.customPath || ''}
            onChange={(e) => handlePlanSaveChange({ customPath: e.target.value || null })}
            placeholder="~/.plannotator/plans/"
            className="w-full px-3 py-2 bg-muted rounded-lg text-sm font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
          <div className="text-[10px] text-muted-foreground">
            Leave empty to use default location
          </div>
        </div>
      )}

      <div className="border-t border-border" />

      <div className="space-y-2">
        <div className="text-sm font-medium">Default Save Action</div>
        <div className="text-xs text-muted-foreground">
          Used for keyboard shortcut ({modKey}+S)
        </div>
        <select
          value={defaultNotesApp}
          onChange={(e) => handleDefaultNotesAppChange(e.target.value as DefaultNotesApp)}
          className="w-full px-3 py-2 bg-muted rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary/50 cursor-pointer"
        >
          <option value="ask">Ask each time</option>
          <option value="download">Download Annotations</option>
          {obsidianAvailable && <option value="obsidian">Obsidian</option>}
          {bearAvailable && <option value="bear">Bear</option>}
          {octarineAvailable && <option value="octarine">Octarine</option>}
        </select>
        <div className="text-[10px] text-muted-foreground">
          {defaultNotesApp === 'ask'
            ? 'Opens Export dialog with Notes tab'
            : defaultNotesApp === 'download'
              ? `${modKey}+S downloads the annotations file`
              : `${modKey}+S saves directly to ${{ obsidian: 'Obsidian', bear: 'Bear', octarine: 'Octarine' }[defaultNotesApp] ?? defaultNotesApp}`}
        </div>
      </div>

      {onNavigateTab && (
        <>
          <div className="border-t border-border" />
          <div className="space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Integrations
            </div>
            {[
              { id: 'int-obsidian', label: 'Obsidian', enabled: obsidian.enabled },
              { id: 'int-bear', label: 'Bear Notes', enabled: bear.enabled },
              { id: 'int-octarine', label: 'Octarine', enabled: octarine.enabled },
            ].map((int) => (
              <button
                key={int.id}
                type="button"
                onClick={() => onNavigateTab(int.id)}
                className="w-full flex items-center justify-between px-3 py-2.5 bg-muted/50 hover:bg-muted rounded-lg text-sm group"
              >
                <span className="text-foreground">{int.label}</span>
                <span className="flex items-center gap-2">
                  <span className={`text-[10px] font-medium ${int.enabled ? 'text-primary' : 'text-muted-foreground'}`}>
                    {int.enabled ? 'Enabled' : 'Off'}
                  </span>
                  <svg className="w-3.5 h-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
};
