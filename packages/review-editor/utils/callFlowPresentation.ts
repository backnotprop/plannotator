import type { CallFlowAdvert, CallFlowInstallPlan } from '@plannotator/shared/call-flow-types';

export function formatCallFlowInstallSize(bytes: number): string {
  const megabytes = Math.ceil(bytes / (1024 * 1024));
  return `~${megabytes.toLocaleString()} MB`;
}

function planDescription(plan: CallFlowInstallPlan): string {
  return `${plan.labels.join(' + ')} support for this review (${formatCallFlowInstallSize(plan.installSizeBytes)} total)`;
}

/**
 * Consent copy shared by the intro dialog and Settings. The server-authored
 * plan is the source of truth, so the languages and size shown beside the
 * toggle are the same targets the install endpoint will resolve.
 */
export function getCallFlowEnableDescription(advert: CallFlowAdvert): string {
  if (advert.reason === 'vcs-unsupported' || advert.reason === 'view-unsupported') {
    return `${advert.message ?? 'Call flow is not available for this review view.'} Switch to a supported local Git review to enable it.`;
  }
  if (advert.installable === false) {
    return 'Uses your externally managed local CallDiff runtime. Plannotator will not install or update language support for this runtime.';
  }
  const plan = advert.consentPlan ?? advert.installPlan;
  if (plan) {
    return `Enabling prepares a small local analysis runtime with ${planDescription(plan)}. If anything is missing, Plannotator installs it automatically in the background. Requires Node.js 22 or newer. Other language support installs automatically as reviews need it.`;
  }
  return 'Enabling uses a local analysis runtime. If managed runtime or language support is missing, Plannotator installs it automatically in the background. Requires Node.js 22 or newer.';
}
