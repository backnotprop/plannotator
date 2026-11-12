import { useEffect, useRef } from 'react';
import type { CallFlowAdvert } from '@plannotator/shared/call-flow-types';
import {
  CALL_FLOW_CORE_LANGUAGE_ID,
  type CallFlowLanguageId,
} from '@plannotator/shared/call-flow-languages';
import type { CallFlowInstallController } from './useCallFlowInstall';

/** Targets are recorded before the request starts, so a failed POST or install cannot cause a render-driven retry loop. */
export function useCallFlowAutoInstall(
  enabled: boolean,
  consentAcknowledged: boolean,
  advert: CallFlowAdvert,
  install: CallFlowInstallController,
): void {
  const attempted = useRef<Set<CallFlowLanguageId>>(new Set());

  useEffect(() => {
    if (!enabled || !consentAcknowledged) return;

    if (
      install.status.state === 'error'
      && install.status.currentLanguageId
      && install.status.currentLanguageId !== CALL_FLOW_CORE_LANGUAGE_ID
      && install.status.languageIds
    ) {
      const failedIndex = install.status.languageIds.indexOf(install.status.currentLanguageId);
      if (failedIndex >= 0) {
        for (const languageId of install.status.languageIds.slice(failedIndex + 1)) {
          attempted.current.delete(languageId);
        }
      }
    }

    if (
      !advert.enabled
      || !advert.installable
      || !advert.installPlan
      || install.status.state === 'running'
    ) {
      return;
    }

    const nextTargets = advert.installPlan.languageIds.filter(
      (languageId) => !attempted.current.has(languageId),
    );
    if (nextTargets.length === 0) return;

    for (const languageId of nextTargets) attempted.current.add(languageId);
    install.start(nextTargets);
  }, [advert.enabled, advert.installPlan, advert.installable, consentAcknowledged, enabled, install.start, install.status.state]);
}
