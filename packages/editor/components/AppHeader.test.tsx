import React from "react";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AppHeader } from "./AppHeader";
import type { ApproveExtraEntry } from "@plannotator/ui/components/ApproveDropdown";

const noop = () => {};

function renderHeader(
  overrides: Partial<React.ComponentProps<typeof AppHeader>> = {},
) {
  const props: React.ComponentProps<typeof AppHeader> = {
    isApiMode: true,
    annotateMode: false,
    archiveMode: false,
    gate: false,
    isSharedSession: false,
    origin: "claude-code",
    isSubmitting: false,
    isExiting: false,
    isPanelOpen: false,
    hasAnyAnnotations: false,
    linkedDocIsActive: false,
    callbackShareUrlReady: true,
    canShareCurrentSession: false,
    agentName: "Claude Code",
    availableAgents: [],
    showAnnotationsWarning: false,
    callbackConfig: null,
    taterMode: false,
    mobileSettingsOpen: false,
    gitUser: undefined,
    onCallbackFeedback: noop,
    onCallbackApprove: noop,
    onAnnotateExit: noop,
    onAnnotateFeedback: noop,
    onAnnotateApprove: noop,
    onFeedback: noop,
    onApprove: noop,
    onAnnotationPanelToggle: noop,
    onArchiveCopy: noop,
    onArchiveDone: noop,
    onTaterModeChange: noop,
    onIdentityChange: noop,
    onUIPreferencesChange: noop,
    onOpenSettings: noop,
    onCloseSettings: noop,
    onOpenExport: noop,
    onCopyAgentInstructions: noop,
    onDownloadAnnotations: noop,
    onPrint: noop,
    onCopyShareLink: noop,
    onOpenImport: noop,
    onSaveToObsidian: noop,
    onSaveToBear: noop,
    onSaveToOctarine: noop,
    appVersion: "test",
    agentInstructionsEnabled: false,
    obsidianConfigured: false,
    bearConfigured: false,
    octarineConfigured: false,
    ...overrides,
  };

  return renderToStaticMarkup(<AppHeader {...props} />);
}

describe("AppHeader approval actions", () => {
  test("renders a Claude Code approval dropdown when extra approval entries are provided", () => {
    const extraEntries: ApproveExtraEntry[] = [
      {
        id: "approve-bypass-native-clear",
        label: "Approve + Bypass + Clear Context (native)",
        onSelect: noop,
      },
    ];

    const html = renderHeader({ approveExtraEntries: extraEntries });

    expect(html).toContain('aria-label="More approval options"');
    expect(html).toContain("Approve");
  });

  test("keeps Claude Code on the plain approve button when no extra entries are provided", () => {
    const html = renderHeader();

    expect(html).not.toContain('aria-label="More approval options"');
    expect(html).toContain("Approve");
  });

  test("keeps annotate gate approvals plain even when plan-review extra entries exist", () => {
    const extraEntries: ApproveExtraEntry[] = [
      {
        id: "approve-bypass-native-clear",
        label: "Approve + Bypass + Clear Context (native)",
        onSelect: noop,
      },
    ];

    const html = renderHeader({
      annotateMode: true,
      gate: true,
      approveExtraEntries: extraEntries,
    });

    expect(html).not.toContain('aria-label="More approval options"');
    expect(html).toContain("Approve");
  });
});
