import React, { useState } from 'react';
import {
  getBearSettings,
  saveBearSettings,
  normalizeTags,
  type BearSettings,
} from '../../utils/bear';
import { ToggleSwitch } from './shared';

export const BearTab: React.FC = () => {
  const [bear, setBear] = useState<BearSettings>(() => getBearSettings());

  const handleChange = (updates: Partial<BearSettings>) => {
    const next = { ...bear, ...updates };
    setBear(next);
    saveBearSettings(next);
  };

  return (
    <div className="space-y-5">
      <ToggleSwitch
        checked={bear.enabled}
        onChange={(v) => handleChange({ enabled: v })}
        label="Bear Notes"
        description="Auto-save approved plans to Bear"
      />

      {bear.enabled && (
        <>
          <div className="border-t border-border" />

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Custom Tags</label>
            <input
              type="text"
              value={bear.customTags}
              onChange={(e) => handleChange({ customTags: e.target.value })}
              onBlur={(e) => handleChange({ customTags: normalizeTags(e.target.value) })}
              placeholder="plan, work"
              className="w-full px-3 py-2 bg-muted rounded-lg text-sm font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
            />
            <div className="text-[10px] text-muted-foreground">
              Comma-separated, kebab-case. Leave empty for auto-generated tags.
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Tag Position</label>
            <select
              value={bear.tagPosition}
              onChange={(e) => handleChange({ tagPosition: e.target.value as 'prepend' | 'append' })}
              className="w-full px-3 py-2 bg-muted rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary/50"
            >
              <option value="append">Append (end of note)</option>
              <option value="prepend">Prepend (after title)</option>
            </select>
          </div>

          <div className="border-t border-border" />

          <ToggleSwitch
            checked={bear.autoSave}
            onChange={(v) => handleChange({ autoSave: v })}
            label="Auto-save on Plan Arrival"
            description="Save to Bear when a plan loads, before you approve or deny"
          />
        </>
      )}
    </div>
  );
};
