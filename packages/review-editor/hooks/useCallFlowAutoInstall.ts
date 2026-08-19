import { useEffect, useRef } from 'react';
import type { CallFlowAdvert } from '@plannotator/shared/call-flow-types';
import {
  CALL_FLOW_CORE_LANGUAGE_ID,
  type CallFlowLanguageId,
} from '@plannotator/shared/call-flow-languages';
import type { CallFlowInstallController } from './useCallFlowInstall';

/**
 * Starts each server-authored managed install target at most once per review
 * session. Targets are recorded before the request starts, so a rejected POST,
 * failed preflight, or failed install cannot create a render-driven retry
 * loop. The ledger is per target: one failed language never suppresses the
 * first attempt for a newly required language. Explicit retries continue to
 * use the controller directly.
 */
export function useCallFlowAutoInstall(
  enabled: boolean,
  consentAcknowledged: boolean,
  advert: CallFlowAdvert,
  install: CallFlowInstallController,
): void {
  const attempted = useRef<Set<CallFlowLanguageId>>(new Set());

  useEffect(() => {
    if (!enabled || !consentAcknowledged) return;

    // The server executes a multi-target flight in order. If an optional pack
    // fails, every target after currentLanguageId was queued but never
    // attempted; release those trailing ids so each still gets its own single
    // automatic attempt. Core is different: every pack depends on it, so
    // releasing trailing ids after a core failure would implicitly retry the
    // failed core when the server prepends it again.
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
