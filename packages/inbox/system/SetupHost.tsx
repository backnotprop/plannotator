import { useEffect, useRef } from 'react';
import type { InboxToastModel } from '../components/Toast';
import { inboxApi, type SettingsModel } from '../api';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { systemShown } from './gate';
import { closeSystemSetup, openSystemSetup, systemSetupLinked, useSystemSetupRequest } from './opener';
import { startFirstDrawing } from './firstDraw';
import { SystemSetupDialog, type SystemSetupDialogProps } from './SetupDialog';
import { SYSTEM_AGENT_NAMES, systemAgentOfLaunch, type SystemSetupAgent } from '@plannotator/core/inbox-system-setup';

async function launchableAgents(launchOn: boolean): Promise<SystemSetupAgent[]> {
  if (!launchOn) return [];
  const read = await inboxApi.composeSessions();
  return (read.launch?.agents ?? []).map((a) => systemAgentOfLaunch(a.agent)).filter((a): a is SystemSetupAgent => a !== null);
}

export interface SystemSetupHostProps {
  settings: Pick<SettingsModel, 'code_review' | 'system' | 'home' | 'launch'> | null;
  phone: boolean;
  showToast: (toast: Omit<InboxToastModel, 'id'>, ms?: number) => void;
  api?: Pick<SystemSetupDialogProps, 'load' | 'save' | 'copy' | 'loadAgents'>;
}

export function SystemSetupHost({ settings, phone, showToast, api }: SystemSetupHostProps) {
  const request = useSystemSetupRequest();
  const on = systemShown(settings);
  const linkUsed = useRef(false);
  useEffect(() => {
    if (!on || linkUsed.current) return;
    linkUsed.current = true;
    const linked = systemSetupLinked(window.location.search);
    if (linked) openSystemSetup(linked.project);
  }, [on]);
  if (!request || !on) return null;
  return (
    <SystemSetupDialog
      key={request.n}
      phone={phone}
      home={settings?.home ?? null}
      loadAgents={api?.loadAgents ?? (() => launchableAgents(settings?.launch !== undefined))}
      startProject={request.project}
      load={api?.load ?? (() => inboxApi.systemSetup())}
      save={api?.save ?? (async (input) => (await inboxApi.saveSystemSetup(input)).setup)}
      copy={api?.copy ?? copyTextToClipboard}
      onDrawIt={startFirstDrawing}
      onCopied={(project, saved) =>
        showToast(
          {
            icon: 'check',
            lead: 'Prompt copied',
            phoneLead: 'Copied',
            detail: `Paste it into ${SYSTEM_AGENT_NAMES[saved.agent]} in ${project.name}`,
            speech: `Prompt copied. Paste it into ${SYSTEM_AGENT_NAMES[saved.agent]} in ${project.name}: it draws the first drawing.`,
          },
          6000,
        )
      }
      onClose={closeSystemSetup}
    />
  );
}
