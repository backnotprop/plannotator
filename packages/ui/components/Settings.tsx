import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { TaterSpritePullup } from './TaterSpritePullup';
import { getIdentity, regenerateIdentity } from '../utils/identity';
import {
  getObsidianSettings,
  saveObsidianSettings,
  type ObsidianSettings,
} from '../utils/obsidian';
import {
  getBearSettings,
  saveBearSettings,
  type BearSettings,
} from '../utils/bear';
import {
  getAgentSwitchSettings,
  saveAgentSwitchSettings,
  AGENT_OPTIONS,
  type AgentSwitchSettings,
} from '../utils/agentSwitch';
import {
  getPlanSaveSettings,
  savePlanSaveSettings,
  type PlanSaveSettings,
} from '../utils/planSave';

interface SettingsProps {
  taterMode: boolean;
  onTaterModeChange: (enabled: boolean) => void;
  onIdentityChange?: (oldIdentity: string, newIdentity: string) => void;
  origin?: 'claude-code' | 'opencode' | null;
}

export const Settings: React.FC<SettingsProps> = ({ taterMode, onTaterModeChange, onIdentityChange, origin }) => {
  const [showDialog, setShowDialog] = useState(false);
  const [identity, setIdentity] = useState('');
  const [obsidian, setObsidian] = useState<ObsidianSettings>({
    enabled: false,
    vaultPath: '',
    folder: 'plannotator',
  });
  const [detectedVaults, setDetectedVaults] = useState<string[]>([]);
  const [vaultsLoading, setVaultsLoading] = useState(false);
  const [bear, setBear] = useState<BearSettings>({ enabled: false });
  const [agent, setAgent] = useState<AgentSwitchSettings>({ switchTo: 'build' });
  const [planSave, setPlanSave] = useState<PlanSaveSettings>({ enabled: true, customPath: null });

  useEffect(() => {
    if (showDialog) {
      setIdentity(getIdentity());
      setObsidian(getObsidianSettings());
      setBear(getBearSettings());
      setAgent(getAgentSwitchSettings());
      setPlanSave(getPlanSaveSettings());
    }
  }, [showDialog]);

  // Fetch detected vaults when Obsidian is enabled
  useEffect(() => {
    if (obsidian.enabled && detectedVaults.length === 0 && !vaultsLoading) {
      setVaultsLoading(true);
      fetch('/api/obsidian/vaults')
        .then(res => res.json())
        .then((data: { vaults: string[] }) => {
          setDetectedVaults(data.vaults || []);
          // Auto-select first vault if none set
          if (data.vaults?.length > 0 && !obsidian.vaultPath) {
            handleObsidianChange({ vaultPath: data.vaults[0] });
          }
        })
        .catch(() => setDetectedVaults([]))
        .finally(() => setVaultsLoading(false));
    }
  }, [obsidian.enabled]);

  const handleObsidianChange = (updates: Partial<ObsidianSettings>) => {
    const newSettings = { ...obsidian, ...updates };
    setObsidian(newSettings);
    saveObsidianSettings(newSettings);
  };

  const handleBearChange = (enabled: boolean) => {
    const newSettings = { enabled };
    setBear(newSettings);
    saveBearSettings(newSettings);
  };

  const handleAgentChange = (switchTo: AgentSwitchSettings['switchTo']) => {
    const newSettings = { switchTo };
    setAgent(newSettings);
    saveAgentSwitchSettings(newSettings);
  };

  const handlePlanSaveChange = (updates: Partial<PlanSaveSettings>) => {
    const newSettings = { ...planSave, ...updates };
    setPlanSave(newSettings);
    savePlanSaveSettings(newSettings);
  };

  const handleRegenerateIdentity = () => {
    const oldIdentity = identity;
    const newIdentity = regenerateIdentity();
    setIdentity(newIdentity);
    onIdentityChange?.(oldIdentity, newIdentity);
  };

  return (
    <>
      <button
        onClick={() => setShowDialog(true)}
        className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        title="Settings"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>

      {showDialog && createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm p-4"
          onClick={() => setShowDialog(false)}
        >
          <div
            className="bg-card border border-border rounded-xl w-full max-w-2xl shadow-2xl relative"
            onClick={e => e.stopPropagation()}
          >
            {taterMode && <TaterSpritePullup />}
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h3 className="font-semibold text-sm">Settings</h3>
              <button
                onClick={() => setShowDialog(false)}
                className="p-1.5 rounded-md bg-muted hover:bg-muted/80 text-foreground transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="p-4 space-y-4">
              {/* Identity Section */}
              <div className="space-y-2">
                <div className="text-sm font-medium">Your Identity</div>
                <div className="text-xs text-muted-foreground">
                  Used when sharing annotations with others
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex-1 px-3 py-2 bg-muted rounded-lg text-xs font-mono truncate">
                    {identity}
                  </div>
                  <button
                    onClick={handleRegenerateIdentity}
                    className="p-2 rounded-lg bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground transition-colors"
                    title="Regenerate identity"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </button>
                </div>
              </div>

              <div className="border-t border-border" />

              {/* Plan Saving */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium">Save Plans</div>
                    <div className="text-xs text-muted-foreground">
                      Auto-save plans to ~/.plannotator/plans/
                    </div>
                  </div>
                  <button
                    role="switch"
                    aria-checked={planSave.enabled}
                    onClick={() => handlePlanSaveChange({ enabled: !planSave.enabled })}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      planSave.enabled ? 'bg-primary' : 'bg-muted'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                        planSave.enabled ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                {planSave.enabled && (
                  <div className="space-y-1.5 pl-0.5">
                    <label className="text-xs text-muted-foreground">Custom Path (optional)</label>
                    <input
                      type="text"
                      value={planSave.customPath || ''}
                      onChange={(e) => handlePlanSaveChange({ customPath: e.target.value || null })}
                      placeholder="~/.plannotator/plans/"
                      className="w-full px-3 py-2 bg-muted rounded-lg text-xs font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                    />
                    <div className="text-[10px] text-muted-foreground/70">
                      Leave empty to use default location
                    </div>
                  </div>
                )}
              </div>

              {origin === 'opencode' && (
                <>
                  <div className="border-t border-border" />

                  {/* Agent Switching (OpenCode only) */}
                  <div className="space-y-2">
                    <div>
                      <div className="text-sm font-medium">Agent Switching</div>
                      <div className="text-xs text-muted-foreground">
                        Which agent to switch to after plan approval
                      </div>
                    </div>
                    <select
                      value={agent.switchTo}
                      onChange={(e) => handleAgentChange(e.target.value as AgentSwitchSettings['switchTo'])}
                      className="w-full px-3 py-2 bg-muted rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary/50 cursor-pointer"
                    >
                      {AGENT_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <div className="text-[10px] text-muted-foreground/70">
                      {AGENT_OPTIONS.find(o => o.value === agent.switchTo)?.description}
                    </div>
                  </div>
                </>
              )}

              <div className="border-t border-border" />

              {/* Tater Mode */}
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">Tater Mode</div>
                <button
                  role="switch"
                  aria-checked={taterMode}
                  onClick={() => onTaterModeChange(!taterMode)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    taterMode ? 'bg-primary' : 'bg-muted'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                      taterMode ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              <div className="border-t border-border" />

              {/* Obsidian Integration */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium">Obsidian Integration</div>
                    <div className="text-xs text-muted-foreground">
                      Auto-save approved plans to your vault
                    </div>
                  </div>
                  <button
                    role="switch"
                    aria-checked={obsidian.enabled}
                    onClick={() => handleObsidianChange({ enabled: !obsidian.enabled })}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      obsidian.enabled ? 'bg-primary' : 'bg-muted'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                        obsidian.enabled ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                {obsidian.enabled && (
                  <div className="space-y-3 pl-0.5">
                    {/* Vault & Folder Row */}
                    <div className="flex gap-3">
                      {/* Vault Path */}
                      <div className="flex-1 space-y-1.5">
                        <label className="text-xs text-muted-foreground">Vault</label>
                        {vaultsLoading ? (
                          <div className="w-full px-3 py-2 bg-muted rounded-lg text-xs text-muted-foreground">
                            Detecting...
                          </div>
                        ) : detectedVaults.length > 0 ? (
                          <select
                            value={obsidian.vaultPath}
                            onChange={(e) => handleObsidianChange({ vaultPath: e.target.value })}
                            className="w-full px-3 py-2 bg-muted rounded-lg text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary/50 cursor-pointer"
                          >
                            {detectedVaults.map((vault) => (
                              <option key={vault} value={vault}>
                                {vault.split('/').pop() || vault}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type="text"
                            value={obsidian.vaultPath}
                            onChange={(e) => handleObsidianChange({ vaultPath: e.target.value })}
                            placeholder="/path/to/vault"
                            className="w-full px-3 py-2 bg-muted rounded-lg text-xs font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                          />
                        )}
                      </div>

                      {/* Folder */}
                      <div className="w-44 space-y-1.5">
                        <label className="text-xs text-muted-foreground">Folder</label>
                        <input
                          type="text"
                          value={obsidian.folder}
                          onChange={(e) => handleObsidianChange({ folder: e.target.value })}
                          placeholder="plannotator"
                          className="w-full px-3 py-2 bg-muted rounded-lg text-xs font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                        />
                      </div>
                    </div>

                    {/* Save path preview */}
                    <div className="text-[10px] text-muted-foreground/70">
                      Plans saved to: {obsidian.vaultPath || '...'}/{obsidian.folder || 'plannotator'}/
                    </div>

                    {/* Frontmatter Preview */}
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
                  </div>
                )}
              </div>

              <div className="border-t border-border" />

              {/* Bear Integration */}
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">Bear Notes</div>
                  <div className="text-xs text-muted-foreground">
                    Auto-save approved plans to Bear
                  </div>
                </div>
                <button
                  role="switch"
                  aria-checked={bear.enabled}
                  onClick={() => handleBearChange(!bear.enabled)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    bear.enabled ? 'bg-primary' : 'bg-muted'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                      bear.enabled ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </div>

              </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};
