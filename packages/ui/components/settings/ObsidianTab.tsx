import React, { useState, useEffect } from 'react';
import {
  getObsidianSettings,
  saveObsidianSettings,
  getEffectiveVaultPath,
  CUSTOM_PATH_SENTINEL,
  DEFAULT_FILENAME_FORMAT,
  type ObsidianSettings,
} from '../../utils/obsidian';
import { ToggleSwitch } from './shared';

interface ObsidianTabProps {
  fetchFn?: typeof globalThis.fetch;
}

export const ObsidianTab: React.FC<ObsidianTabProps> = ({ fetchFn = globalThis.fetch }) => {
  const [obsidian, setObsidian] = useState<ObsidianSettings>(() => getObsidianSettings());
  const [detectedVaults, setDetectedVaults] = useState<string[]>([]);
  const [vaultsLoading, setVaultsLoading] = useState(false);

  const handleChange = (updates: Partial<ObsidianSettings>) => {
    const next = { ...obsidian, ...updates };
    setObsidian(next);
    saveObsidianSettings(next);
  };

  useEffect(() => {
    if (!obsidian.enabled || detectedVaults.length > 0 || vaultsLoading) return;
    setVaultsLoading(true);
    fetchFn('/api/obsidian/vaults')
      .then((r) => r.json())
      .then((data: { vaults?: string[] }) => {
        const vaults = data.vaults ?? [];
        setDetectedVaults(vaults);
        if (vaults.length > 0 && !obsidian.vaultPath) {
          handleChange({ vaultPath: vaults[0] });
        }
      })
      .catch(() => {})
      .finally(() => setVaultsLoading(false));
  }, [obsidian.enabled]);

  const filenamePreview = (() => {
    const fmt = obsidian.filenameFormat?.trim() || DEFAULT_FILENAME_FORMAT;
    const now = new Date();
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const h24 = now.getHours();
    const h12 = h24 % 12 || 12;
    const vars: Record<string, string> = {
      title: 'My Plan Title', YYYY: String(now.getFullYear()),
      MM: String(now.getMonth()+1).padStart(2,'0'), DD: String(now.getDate()).padStart(2,'0'),
      Mon: months[now.getMonth()], D: String(now.getDate()),
      HH: String(h24).padStart(2,'0'), h: String(h12), hh: String(h12).padStart(2,'0'),
      mm: String(now.getMinutes()).padStart(2,'0'), ss: String(now.getSeconds()).padStart(2,'0'),
      ampm: h24 >= 12 ? 'pm' : 'am',
    };
    let preview = fmt.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m) + '.md';
    if (obsidian.filenameSeparator === 'dash') preview = preview.replace(/ /g, '-');
    else if (obsidian.filenameSeparator === 'underscore') preview = preview.replace(/ /g, '_');
    return preview;
  })();

  return (
    <div className="space-y-5">
      <ToggleSwitch
        checked={obsidian.enabled}
        onChange={(v) => handleChange({ enabled: v })}
        label="Obsidian Integration"
        description="Auto-save approved plans to your vault"
      />

      {obsidian.enabled && (
        <>
          <div className="border-t border-border" />

          <div className="space-y-3">
            <div className="flex gap-3">
              <div className="flex-1 space-y-1.5">
                <label className="text-xs text-muted-foreground">Vault</label>
                {vaultsLoading ? (
                  <div className="w-full px-3 py-2 bg-muted rounded-lg text-xs text-muted-foreground">Detecting…</div>
                ) : detectedVaults.length > 0 ? (
                  <>
                    <select
                      value={obsidian.vaultPath}
                      onChange={(e) => handleChange({ vaultPath: e.target.value })}
                      className="w-full px-3 py-2 bg-muted rounded-lg text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary/50 cursor-pointer"
                    >
                      {detectedVaults.map((vault) => (
                        <option key={vault} value={vault}>{vault.split('/').pop() || vault}</option>
                      ))}
                      <option value={CUSTOM_PATH_SENTINEL}>Custom path…</option>
                    </select>
                    {obsidian.vaultPath === CUSTOM_PATH_SENTINEL && (
                      <input
                        type="text"
                        value={obsidian.customPath || ''}
                        onChange={(e) => handleChange({ customPath: e.target.value })}
                        placeholder="/path/to/vault"
                        className="w-full mt-2 px-3 py-2 bg-muted rounded-lg text-xs font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                      />
                    )}
                  </>
                ) : (
                  <input
                    type="text"
                    value={obsidian.vaultPath}
                    onChange={(e) => handleChange({ vaultPath: e.target.value })}
                    placeholder="/path/to/vault"
                    className="w-full px-3 py-2 bg-muted rounded-lg text-xs font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                  />
                )}
              </div>
              <div className="w-44 space-y-1.5">
                <label className="text-xs text-muted-foreground">Folder</label>
                <input
                  type="text"
                  value={obsidian.folder}
                  onChange={(e) => handleChange({ folder: e.target.value })}
                  placeholder="plannotator"
                  className="w-full px-3 py-2 bg-muted rounded-lg text-xs font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Filename Format</label>
              <input
                type="text"
                value={obsidian.filenameFormat || ''}
                onChange={(e) => handleChange({ filenameFormat: e.target.value || undefined })}
                placeholder={DEFAULT_FILENAME_FORMAT}
                className="w-full px-3 py-2 bg-muted rounded-lg text-xs font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
              />
              <div className="text-[10px] text-muted-foreground">
                Variables: <code className="text-[10px]">{'{title}'}</code> <code className="text-[10px]">{'{YYYY}'}</code> <code className="text-[10px]">{'{MM}'}</code> <code className="text-[10px]">{'{DD}'}</code> <code className="text-[10px]">{'{Mon}'}</code> <code className="text-[10px]">{'{D}'}</code> <code className="text-[10px]">{'{HH}'}</code> <code className="text-[10px]">{'{h}'}</code> <code className="text-[10px]">{'{hh}'}</code> <code className="text-[10px]">{'{mm}'}</code> <code className="text-[10px]">{'{ss}'}</code> <code className="text-[10px]">{'{ampm}'}</code>
              </div>
              <div className="text-[10px] text-muted-foreground">
                Preview: {filenamePreview}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Filename Separator</label>
              <select
                value={obsidian.filenameSeparator || 'space'}
                onChange={(e) => handleChange({ filenameSeparator: e.target.value as 'space' | 'dash' | 'underscore' })}
                className="w-full px-3 py-2 bg-muted rounded-lg text-xs focus:outline-none focus:ring-1 focus:ring-primary/50"
              >
                <option value="space">Spaces (default)</option>
                <option value="dash">Dashes (-)</option>
                <option value="underscore">Underscores (_)</option>
              </select>
              <div className="text-[10px] text-muted-foreground">
                Replaces spaces in the generated filename. Useful when working with CLI tools in your vault.
              </div>
            </div>

            <div className="text-[10px] text-muted-foreground">
              Plans saved to: {getEffectiveVaultPath(obsidian) || '…'}/{obsidian.folder || 'plannotator'}/
            </div>

            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Frontmatter (auto-generated)</label>
              <pre className="px-3 py-2 bg-muted/50 rounded-lg text-[10px] font-mono text-muted-foreground overflow-x-auto">
{`---
created: ${new Date().toISOString().slice(0, 19)}Z
source: plannotator
tags: [plan, ...]
---`}
              </pre>
            </div>

            <div className="border-t border-border" />

            <ToggleSwitch
              checked={obsidian.autoSave}
              onChange={(v) => handleChange({ autoSave: v })}
              label="Auto-save on Plan Arrival"
              description="Save to Obsidian when a plan loads, before you approve or deny"
            />

            <ToggleSwitch
              checked={obsidian.vaultBrowserEnabled ?? false}
              onChange={(v) => handleChange({ vaultBrowserEnabled: v })}
              label="Vault Browser"
              description="Browse and annotate vault files from the sidebar"
            />
          </div>
        </>
      )}
    </div>
  );
};
