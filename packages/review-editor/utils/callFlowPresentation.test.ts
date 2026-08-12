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

    // Assert the facts, not the prose: the languages and size shown beside
    // the toggle must be the server plan's, and the Node floor must be
    // disclosed. The sentence around them is free to change.
    const description = getCallFlowEnableDescription(advert);
    expect(description).toContain('JavaScript and TypeScript');
    expect(description).toContain('Bash');
    expect(description).toContain('~7 MB');
    expect(description).toContain('Node.js 22');
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
    expect(description).not.toContain('Installs');
  });
});
