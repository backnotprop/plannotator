/**
 * The open document's name beside the logo (#2061, DOM-gated). Failures to
 * catch: the name not drawn, its full path lost (no tooltip on hover, nothing
 * for a screen reader), a review of several files naming the open file twice
 * (switcher plus name), the compact header picking the name up, and a folder
 * session's folder path drawn without its start cut.
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

type Extra = Partial<ReturnType<typeof baseProps>> & {
  documentName?: { name: string; title?: string };
  bundleSwitcher?: React.ComponentProps<NonNullable<typeof headerModule>['AppHeader']>['bundleSwitcher'];
  compactTouchLayout?: boolean;
  compactDocumentTitle?: string;
};

async function render(extra: Extra) {
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
  return host;
}

async function hover(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('mouseenter'));
    el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 450));
  });
}

const nameOf = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-header-document-name]');

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = originalFetch;
});

describe.skipIf(!hasDom)('AppHeader document name', () => {
  test('shows the name beside the logo and the full path on hover', async () => {
    const el = await render({ documentName: { name: 'rollout-plan.md', title: '/repo/docs/rollout-plan.md' } });
    const name = nameOf(el)!;
    expect(name.textContent).toBe('rollout-plan.md');
    expect(name.hasAttribute('title')).toBe(false);
    // Screen readers get the path without hovering.
    const describedBy = name.getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)?.textContent).toBe('/repo/docs/rollout-plan.md');

    expect(document.querySelector('[data-pn-tooltip]')).toBeNull();
    await hover(name);
    expect(document.querySelector('[data-pn-tooltip]')?.textContent).toBe('/repo/docs/rollout-plan.md');
  });

  // A folder session's folder. Fails if the path is drawn as plain text cut at
  // its end (a long path then loses the folder's own name), if the folder's
  // name is not a part of its own that never shrinks, or if the full path
  // stops reaching the tooltip and screen readers.
  test('a folder path is cut from the start: the folder name its own part, the full path on hover', async () => {
    const path = 'C:\\repo\\docs\\changes\\add-refund-flow';
    const el = await render({ documentName: { name: path, title: path, cutsFromStart: true } });
    const name = nameOf(el)!;
    expect(name.textContent).toBe(path);
    expect(name.querySelector('[data-start-cut-path-last]')?.textContent).toBe('add-refund-flow');
    expect(name.querySelector('[data-start-cut-path-folders]')?.textContent).toBe('C:\\repo\\docs\\changes\\');
    const describedBy = name.getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)?.textContent).toBe(path);

    await hover(name);
    expect(document.querySelector('[data-pn-tooltip]')?.textContent).toBe(path);
  });

  test('a name with no path (last message) has no tooltip', async () => {
    const el = await render({ documentName: { name: 'Last message' } });
    const name = nameOf(el)!;
    expect(name.textContent).toBe('Last message');
    expect(name.getAttribute('aria-describedby')).toBeNull();
    await hover(name);
    expect(document.querySelector('[data-pn-tooltip]')).toBeNull();
  });

  test('a review of several files keeps its switcher and names the file once', async () => {
    const el = await render({
      documentName: { name: 'spec.md', title: '/repo/spec.md' },
      bundleSwitcher: { index: 1, total: 2, name: 'spec.md', title: '/repo/spec.md', onPrevious: noop, onNext: noop },
    });
    expect(el.querySelector('[data-bundle-switcher]')).not.toBeNull();
    expect(nameOf(el)).toBeNull();
    expect(el.querySelector('header')!.textContent!.split('spec.md').length - 1).toBe(1);
  });

  test('no name passed (plan review): the header shows only the logo', async () => {
    const el = await render({});
    expect(nameOf(el)).toBeNull();
  });

  test('the compact header is unchanged', async () => {
    const el = await render({
      compactTouchLayout: true,
      compactDocumentTitle: 'rollout-plan.md',
      documentName: { name: 'rollout-plan.md', title: '/repo/docs/rollout-plan.md' },
    });
    expect(nameOf(el)).toBeNull();
    expect(el.querySelector('[data-pn-compact-document-title]')?.textContent).toBe('rollout-plan.md');
  });
});
