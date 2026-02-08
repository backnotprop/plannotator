import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { TaterSpritePullup } from './TaterSpritePullup';
import { getIdentity, regenerateIdentity } from '../utils/identity';
import {
  getObsidianSettings,
  saveObsidianSettings,
  CUSTOM_PATH_SENTINEL,
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
import {
  getUIPreferences,
  saveUIPreferences,
  type UIPreferences,
} from '../utils/uiPreferences';
import {
  getPermissionModeSettings,
  savePermissionModeSettings,
  PERMISSION_MODE_OPTIONS,
  type PermissionMode,
} from '../utils/permissionMode';
import { useAgents } from '../hooks/useAgents';

type SettingsTab = 'general' | 'display' | 'saving';

interface SettingsProps {
  taterMode: boolean;
  onTaterModeChange: (enabled: boolean) => void;
  onIdentityChange?: (oldIdentity: string, newIdentity: string) => void;
  origin?: 'claude-code' | 'opencode' | null;
  /** Mode determines which settings are shown. 'plan' shows all, 'review' shows only identity + agent switching */
  mode?: 'plan' | 'review';
  onUIPreferencesChange?: (prefs: UIPreferences) => void;
}

export const Settings: React.FC<SettingsProps> = ({ taterMode, onTaterModeChange, onIdentityChange, origin, mode = 'plan', onUIPreferencesChange }) => {
  const [showDialog, setShowDialog] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
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
  const [uiPrefs, setUiPrefs] = useState<UIPreferences>({ tocEnabled: true, stickyActionsEnabled: true });
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('bypassPermissions');
  const [agentWarning, setAgentWarning] = useState<string | null>(null);

  // Fetch available agents for OpenCode
  const { agents: availableAgents, validateAgent, getAgentWarning } = useAgents(origin ?? null);

  const tabs = useMemo(() => {
    const t: { id: SettingsTab; label: string }[] = [{ id: 'general', label: 'General' }];
    if (mode === 'plan') {
      t.push({ id: 'display', label: 'Display' });
      t.push({ id: 'saving', label: 'Saving' });
    }
    return t;
  }, [mode]);

  useEffect(() => {
    if (showDialog) {
      setIdentity(getIdentity());
      setObsidian(getObsidianSettings());
      setBear(getBearSettings());
      setAgent(getAgentSwitchSettings());
      setPlanSave(getPlanSaveSettings());
      setUiPrefs(getUIPreferences());
      setPermissionMode(getPermissionModeSettings().mode);

      // Validate agent setting when dialog opens
      if (origin === 'opencode') {
        setAgentWarning(getAgentWarning());
      }
    }
  }, [showDialog, availableAgents, origin, getAgentWarning]);

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

  const handleAgentChange = (switchTo: AgentSwitchSettings['switchTo'], customName?: string) => {
    const newSettings = { switchTo, customName: customName ?? agent.customName };
    setAgent(newSettings);
    saveAgentSwitchSettings(newSettings);
  };

  const handlePlanSaveChange = (updates: Partial<PlanSaveSettings>) => {
    const newSettings = { ...planSave, ...updates };
    setPlanSave(newSettings);
    savePlanSaveSettings(newSettings);
  };

  const handleUIPrefsChange = (updates: Partial<UIPreferences>) => {
    const newPrefs = { ...uiPrefs, ...updates };
    setUiPrefs(newPrefs);
    saveUIPreferences(newPrefs);
    onUIPreferencesChange?.(newPrefs);
  };

  const handlePermissionModeChange = (mode: PermissionMode) => {
    setPermissionMode(mode);
    savePermissionModeSettings(mode);
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

            <div className="flex" style={{ minHeight: '420px' }}>
              {/* Sidebar — only if multiple tabs */}
              {tabs.length > 1 && (
                <nav className="w-40 border-r border-border p-2 space-y-1 flex-shrink-0">
                  {tabs.map(tab => (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`w-full text-left px-3 py-1.5 rounded text-sm transition-colors ${
                        activeTab === tab.id
                          ? 'bg-primary/10 text-primary font-medium'
                          : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </nav>
              )}

              {/* Content — scrollable */}
              <div className="flex-1 p-4 space-y-4 overflow-y-auto max-h-[70vh]">

                {/* === GENERAL TAB === */}
                {activeTab === 'general' && (
                  <>
                    {/* Identity */}
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

                    {/* Permission Mode (Claude Code only) */}
                    {origin === 'claude-code' && mode === 'plan' && (
                      <>
                        <div className="border-t border-border" />
                        <div className="space-y-2">
                          <div>
                            <div className="text-sm font-medium">Permission Mode</div>
                            <div className="text-xs text-muted-foreground">
                              Automation level after plan approval
                            </div>
                          </div>
                          <select
                            value={permissionMode}
                            onChange={(e) => handlePermissionModeChange(e.target.value as PermissionMode)}
                            className="w-full px-3 py-2 bg-muted rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary/50 cursor-pointer"
                          >
                            {PERMISSION_MODE_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                          <div className="text-[10px] text-muted-foreground/70">
                            {PERMISSION_MODE_OPTIONS.find(o => o.value === permissionMode)?.description}
                          </div>
                        </div>
                      </>
                    )}

                    {/* Agent Switching (OpenCode only) */}
                    {origin === 'opencode' && (
                      <>
                        <div className="border-t border-border" />
                        <div className="space-y-2">
                          <div>
                            <div className="text-sm font-medium">Agent Switching</div>
                            <div className="text-xs text-muted-foreground">
                              Which agent to switch to after plan approval
                            </div>
                          </div>

                          {agentWarning && (
                            <div className="flex items-start gap-2 p-2 bg-amber-500/10 border border-amber-500/30 rounded-lg text-xs text-amber-600 dark:text-amber-400">
                              <svg className="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                              </svg>
                              <span>{agentWarning}</span>
                            </div>
                          )}

                          <select
                            value={agent.switchTo}
                            onChange={(e) => {
                              handleAgentChange(e.target.value);
                              setAgentWarning(null);
                            }}
                            className="w-full px-3 py-2 bg-muted rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary/50 cursor-pointer"
                          >
                            {availableAgents.length > 0 ? (
                              <>
                                {agent.switchTo !== 'custom' &&
                                 agent.switchTo !== 'disabled' &&
                                 !availableAgents.some(a => a.id.toLowerCase() === agent.switchTo.toLowerCase()) && (
                                  <option value={agent.switchTo} disabled>
                                    {agent.switchTo} (not found)
                                  </option>
                                )}
                                {availableAgents.map((a) => (
                                  <option key={a.id} value={a.id}>
                                    {a.name}
                                  </option>
                                ))}
                                <option value="custom">Custom</option>
                                <option value="disabled">Disabled</option>
                              </>
                            ) : (
                              AGENT_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))
                            )}
                          </select>
                          {agent.switchTo === 'custom' && (
                            <input
                              type="text"
                              value={agent.customName || ''}
                              onChange={(e) => {
                                const customName = e.target.value;
                                handleAgentChange('custom', customName);
                                if (customName && availableAgents.length > 0) {
                                  if (!validateAgent(customName)) {
                                    setAgentWarning(`Agent "${customName}" not found in OpenCode. It may cause errors.`);
                                  } else {
                                    setAgentWarning(null);
                                  }
                                } else {
                                  setAgentWarning(null);
                                }
                              }}
                              placeholder="Enter agent name..."
                              className="w-full px-3 py-2 bg-muted rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary/50 placeholder:text-muted-foreground/50"
                            />
                          )}
                          <div className="text-[10px] text-muted-foreground/70">
                            {agent.switchTo === 'custom' && agent.customName
                              ? `Switch to "${agent.customName}" agent after approval`
                              : agent.switchTo === 'disabled'
                                ? 'Stay on current agent after approval'
                                : `Switch to ${agent.switchTo} agent after approval`}
                          </div>
                        </div>
                      </>
                    )}
                  </>
                )}

                {/* === DISPLAY TAB === */}
                {activeTab === 'display' && (
                  <>
                    {/* Table of Contents */}
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-medium">Table of Contents</div>
                        <div className="text-xs text-muted-foreground">
                          Show sidebar navigation on desktop
                        </div>
                      </div>
                      <button
                        role="switch"
                        aria-checked={uiPrefs.tocEnabled}
                        onClick={() => handleUIPrefsChange({ tocEnabled: !uiPrefs.tocEnabled })}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          uiPrefs.tocEnabled ? 'bg-primary' : 'bg-muted'
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                            uiPrefs.tocEnabled ? 'translate-x-6' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </div>

                    <div className="border-t border-border" />

                    {/* Sticky Actions */}
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-medium">Sticky Actions</div>
                        <div className="text-xs text-muted-foreground">
                          Keep action buttons visible while scrolling
                        </div>
                      </div>
                      <button
                        role="switch"
                        aria-checked={uiPrefs.stickyActionsEnabled}
                        onClick={() => handleUIPrefsChange({ stickyActionsEnabled: !uiPrefs.stickyActionsEnabled })}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                          uiPrefs.stickyActionsEnabled ? 'bg-primary' : 'bg-muted'
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                            uiPrefs.stickyActionsEnabled ? 'translate-x-6' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </div>

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
                  </>
                )}

                {/* === SAVING TAB === */}
                {activeTab === 'saving' && (
                  <>
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
                          <div className="flex gap-3">
                            <div className="flex-1 space-y-1.5">
                              <label className="text-xs text-muted-foreground">Vault</label>
                              {vaultsLoading ? (
                                <div className="w-full px-3 py-2 bg-muted rounded-lg text-xs text-muted-foreground">
                                  Detecting...
                                </div>
                              ) : detectedVaults.length > 0 ? (
                                <>
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
                                    <option value={CUSTOM_PATH_SENTINEL}>Custom path...</option>
                                  </select>
                                  {obsidian.vaultPath === CUSTOM_PATH_SENTINEL && (
                                    <input
                                      type="text"
                                      value={obsidian.customPath || ''}
                                      onChange={(e) => handleObsidianChange({ customPath: e.target.value })}
                                      placeholder="/path/to/vault"
                                      className="w-full mt-2 px-3 py-2 bg-muted rounded-lg text-xs font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                                    />
                                  )}
                                </>
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

                          <div className="text-[10px] text-muted-foreground/70">
                            Plans saved to: {obsidian.vaultPath === CUSTOM_PATH_SENTINEL
                              ? (obsidian.customPath || '...')
                              : (obsidian.vaultPath || '...')}/{obsidian.folder || 'plannotator'}/
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
                  </>
                )}

              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};
