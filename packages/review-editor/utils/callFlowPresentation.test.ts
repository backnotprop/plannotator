import { describe, expect, test } from 'bun:test';
import type { CallFlowAdvert } from '@plannotator/shared/call-flow-types';
import { getCallFlowEnableDescription } from './callFlowPresentation';

describe('getCallFlowEnableDescription', () => {
  test('uses the server-authored target labels and rounded total', () => {
    const advert: CallFlowAdvert = {
      enabled: false,
      available: false,
      state: 'disabled',
      provider: 'calldiff',
      installable: true,
      consentPlan: {
        languageIds: ['javascript-typescript', 'bash'],
        labels: ['JavaScript and TypeScript', 'Bash'],
        changedFiles: 7,
        installSizeBytes: 7 * 1024 * 1024,
      },
    };

    expect(getCallFlowEnableDescription(advert)).toBe(
      'Enabling prepares a small local analysis runtime with JavaScript and TypeScript + Bash support for this review (~7 MB total). If anything is missing, Plannotator installs it automatically in the background. Requires Node.js 22 or newer. Other language support installs automatically as reviews need it.',
    );
  });

  test('does not promise managed installation for an override runtime', () => {
    expect(getCallFlowEnableDescription({
      enabled: false,
      available: false,
      state: 'disabled',
      provider: 'calldiff',
      installable: false,
    })).toContain('will not install or update language support');
  });

  test('does not promise installation in an unsupported disabled review view', () => {
    const description = getCallFlowEnableDescription({
      enabled: false,
      available: false,
      state: 'disabled',
      provider: 'calldiff',
      reason: 'view-unsupported',
      message: 'Call flow is not available for this review view.',
    });
    expect(description).toContain('Switch to a supported local Git review');
    expect(description).not.toContain('installs it automatically');
  });
});
