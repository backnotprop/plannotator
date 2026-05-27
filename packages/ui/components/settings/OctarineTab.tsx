import React, { useState } from 'react';
import {
  getOctarineSettings,
  saveOctarineSettings,
  type OctarineSettings,
} from '../../utils/octarine';
import { ToggleSwitch } from './shared';

export const OctarineTab: React.FC = () => {
  const [octarine, setOctarine] = useState<OctarineSettings>(() => getOctarineSettings());

  const handleChange = (updates: Partial<OctarineSettings>) => {
    const next = { ...octarine, ...updates };
    setOctarine(next);
    saveOctarineSettings(next);
  };

  return (
    <div className="space-y-5">
      <ToggleSwitch
        checked={octarine.enabled}
        onChange={(v) => handleChange({ enabled: v })}
        label="Octarine"
        description="Auto-save approved plans to Octarine"
      />

      {octarine.enabled && (
        <>
          <div className="border-t border-border" />

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Workspace Name</label>
            <input
              type="text"
              value={octarine.workspace}
              onChange={(e) => handleChange({ workspace: e.target.value })}
              placeholder="My Workspace"
              className="w-full px-3 py-2 bg-muted rounded-lg text-sm font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
            <div className="text-[10px] text-muted-foreground">
              The Octarine workspace name to save plans into.
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Folder</label>
            <input
              type="text"
              value={octarine.folder}
              onChange={(e) => handleChange({ folder: e.target.value })}
              placeholder="plannotator"
              className="w-full px-3 py-2 bg-muted rounded-lg text-sm font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
            <div className="text-[10px] text-muted-foreground">
              Subfolder within the workspace for saved plans.
            </div>
          </div>

          <div className="text-[10px] text-muted-foreground">
            Plans saved to: {octarine.workspace || '…'} / {octarine.folder || 'plannotator'}/
          </div>

          <div className="border-t border-border" />

          <ToggleSwitch
            checked={octarine.autoSave}
            onChange={(v) => handleChange({ autoSave: v })}
            label="Auto-save on Plan Arrival"
            description="Save to Octarine when a plan loads, before you approve or deny"
          />
        </>
      )}
    </div>
  );
};
