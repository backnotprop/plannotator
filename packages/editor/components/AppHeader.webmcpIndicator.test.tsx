/**
 * Indicator policy (DOM-gated): nothing in the header may appear merely
 * because the browser exposes WebMCP (`webmcpAvailable`); the "Agent"
 * affordance renders only once `agentConnected` (first successful tool
 * call) is true. Pins the maintainer ruling against a "Tools available"
 * chip creeping back in.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const headerModule = hasDom ? await import('./AppHeader') : null;

const noop = () => {};

function baseProps(): React.ComponentProps<typeof headerModule extends null ? never : NonNullable<typeof headerModule>['AppHeader']> {
  return {
    isApiMode: true, annotateMode: false, archiveMode: false, goalSetupMode: false, goalSetupCanSubmit: false, goalSetupIsSubmitting: false,
    goalSetupSubmitLabel: 'Submit', isSharedSession: false, origin: null,
    isSubmitting: false, isExiting: false, isPanelOpen: false, aiAvailable: false, isAIChatOpen: false, aiHasMessages: false,
    annotationCount: 0, linkedDocIsActive: false, callbackShareUrlReady: false, canShareCurrentSession: false,
    agentName: 'Claude', availableAgents: [], showAnnotationsWarning: false,
    callbackConfig: null, taterMode: false, mobileSettingsOpen: false, gitUser: undefined, agentTerminalAvailable: false,
    onCallbackFeedback: noop, onCallbackApprove: noop, onAnnotateExit: noop, onGoalSetupExit: noop, onGoalSetupSubmit: noop,
    onFeedback: noop, onApprove: noop, onAnnotationPanelToggle: noop, onAIChatToggle: noop,
    onArchiveCopy: noop, onArchiveDone: noop, onTaterModeChange: noop, onIdentityChange: noop, onUIPreferencesChange: noop,
    onOpenSettings: noop, onCloseSettings: noop, onOpenExport: noop, onCopyAgentInstructions: noop, onDownloadAnnotations: noop, onPrint: noop,
    onCopyShareLink: noop, onOpenImport: noop, onSaveToObsidian: noop, onSaveToBear: noop, onSaveToOctarine: noop,
    appVersion: '0.0.0', agentInstructionsEnabled: false, obsidianConfigured: false, bearConfigured: false, octarineConfigured: false,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
const originalFetch = globalThis.fetch;

async function render(extra: { webmcpAvailable?: boolean; agentConnected?: boolean }) {
  globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
  host = document.createElement('div');
  document.body.appendChild(host);
  const { AppHeader } = headerModule!;
  await act(async () => {
    root = createRoot(host!);
    root.render(<AppHeader {...baseProps()} {...extra} />);
  });
  return host;
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = originalFetch;
});

describe.skipIf(!hasDom)('AppHeader WebMCP indicator', () => {
  test('the API merely existing renders nothing', async () => {
    const el = await render({ webmcpAvailable: true, agentConnected: false });
    expect(el.querySelector('[data-webmcp-indicator]')).toBeNull();
    expect(el.textContent).not.toContain('Agent');
  });

  test('the indicator appears only after an agent has acted', async () => {
    const el = await render({ webmcpAvailable: true, agentConnected: true });
    expect(el.querySelector('[data-webmcp-indicator]')).not.toBeNull();
  });
});
