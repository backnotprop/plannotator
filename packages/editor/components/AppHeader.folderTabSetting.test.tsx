/**
 * Where Settings → General → "Name the tab after the folder" shows (DOM-gated).
 * Every annotate session offers it, a single file included, so it can be set
 * before a folder is opened; plan review never names a folder and gets none.
 * Failures to catch: the row hidden outside folder sessions again, and the
 * row leaking into plan review.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const headerModule = hasDom ? await import('./AppHeader') : null;
const tooltipModule = hasDom ? await import('@plannotator/ui/components/Tooltip') : null;

const noop = () => {};

function baseProps(): React.ComponentProps<typeof headerModule extends null ? never : NonNullable<typeof headerModule>['AppHeader']> {
  return {
    isApiMode: true, annotateMode: true, archiveMode: false, goalSetupMode: false, goalSetupCanSubmit: false, goalSetupIsSubmitting: false,
    goalSetupSubmitLabel: 'Submit', isSharedSession: false, origin: null,
    isSubmitting: false, isExiting: false, isPanelOpen: false, aiAvailable: false, isAIChatOpen: false, aiHasMessages: false,
    annotationCount: 0, linkedDocIsActive: false, callbackShareUrlReady: false, canShareCurrentSession: false,
    agentName: 'Claude', availableAgents: [], showAnnotationsWarning: false,
    callbackConfig: null, taterMode: false, mobileSettingsOpen: true, gitUser: undefined, agentTerminalAvailable: false,
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

/** The header with Settings open (`mobileSettingsOpen`). */
async function render(extra: Partial<ReturnType<typeof baseProps>>) {
  globalThis.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
  host = document.createElement('div');
  document.body.appendChild(host);
  const { AppHeader } = headerModule!;
  const { TooltipProvider } = tooltipModule!;
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <TooltipProvider delayDuration={0}>
        <AppHeader {...baseProps()} {...extra} />
      </TooltipProvider>,
    );
  });
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = originalFetch;
  document.body.replaceChildren();
});

describe.skipIf(!hasDom)('AppHeader: where "Name the tab after the folder" shows', () => {
  test('an annotate session offers it, a single file included', async () => {
    await render({ annotateMode: true, documentName: { name: 'rollout-plan.md', title: '/repo/docs/rollout-plan.md' } });
    expect(document.querySelector('[role="dialog"]'), 'Settings is open').not.toBeNull();
    expect(document.querySelector('[data-folder-tab-setting]')?.textContent).toContain('Name the tab after the folder');
  });

  test('plan review gets none', async () => {
    await render({ annotateMode: false });
    expect(document.querySelector('[role="dialog"]'), 'Settings is open').not.toBeNull();
    expect(document.querySelector('[data-folder-tab-setting]')).toBeNull();
  });
});
