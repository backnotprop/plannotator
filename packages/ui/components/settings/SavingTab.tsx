import React, { useState } from 'react';
import {
  getPlanSaveSettings,
  savePlanSaveSettings,
  type PlanSaveSettings,
} from '../../utils/planSave';
import { ToggleSwitch } from './shared';

export const SavingTab: React.FC = () => {
  const [planSave, setPlanSave] = useState<PlanSaveSettings>(() => getPlanSaveSettings());

  const handlePlanSaveChange = (updates: Partial<PlanSaveSettings>) => {
    const next = { ...planSave, ...updates };
    setPlanSave(next);
    savePlanSaveSettings(next);
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
    </div>
  );
};
