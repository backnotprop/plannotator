import { describe, expect, test } from 'bun:test';
import {
  canUseAnnotateWideMode,
  resolveWideModeExitLayout,
  type WideModeLayoutSnapshot,
} from './wideMode';

const snapshot: WideModeLayoutSnapshot = {
  sidebarIsOpen: true,
  sidebarTab: 'files',
  panelOpen: true,
};

describe('canUseAnnotateWideMode', () => {
  test('enables wide mode outside archive and diff', () => {
    expect(canUseAnnotateWideMode({
      archiveMode: false,
      isPlanDiffActive: false,
    })).toBe(true);

    expect(canUseAnnotateWideMode({
      archiveMode: true,
      isPlanDiffActive: false,
    })).toBe(false);

    expect(canUseAnnotateWideMode({
      archiveMode: false,
      isPlanDiffActive: true,
    })).toBe(false);

    expect(canUseAnnotateWideMode({
      archiveMode: true,
      isPlanDiffActive: true,
    })).toBe(false);
  });
});

describe('resolveWideModeExitLayout', () => {
  test('restores the saved sidebar tab and panel by default', () => {
    expect(resolveWideModeExitLayout(snapshot)).toEqual({
      sidebarOpen: true,
      sidebarTab: 'files',
      panelOpen: true,
    });
  });

  test('opens an explicit sidebar target and can keep the panel closed', () => {
    expect(resolveWideModeExitLayout(snapshot, {
      restore: false,
      sidebarTab: 'toc',
      panelOpen: false,
    })).toEqual({
      sidebarOpen: true,
      sidebarTab: 'toc',
      panelOpen: false,
    });
  });

  test('honors an explicit panel reopen without restoring the sidebar snapshot', () => {
    expect(resolveWideModeExitLayout(snapshot, {
      restore: false,
      panelOpen: true,
    })).toEqual({
      sidebarOpen: false,
      sidebarTab: null,
      panelOpen: true,
    });
  });

  test('keeps the panel closed when leaving wide mode without restore', () => {
    expect(resolveWideModeExitLayout(snapshot, {
      restore: false,
    })).toEqual({
      sidebarOpen: false,
      sidebarTab: null,
      panelOpen: undefined,
    });
  });

  test('falls back to a closed layout when the snapshot is missing', () => {
    expect(resolveWideModeExitLayout(null)).toEqual({
      sidebarOpen: false,
      sidebarTab: null,
      panelOpen: false,
    });
  });
});
