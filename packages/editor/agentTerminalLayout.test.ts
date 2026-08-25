import { describe, expect, test } from 'bun:test';
import type { AnnotateAgentTerminalSide } from '@plannotator/ui/utils/annotateAgentTerminal';
import {
  getAgentTerminalLayout,
  type AgentTerminalLayoutOptions,
} from './agentTerminalLayout';

const SIDES: AnnotateAgentTerminalSide[] = ['left', 'right', 'hidden'];
const BOOLS = [false, true];

/** Every combination the annotate shell can actually be in. */
function everyCase(): AgentTerminalLayoutOptions[] {
  const cases: AgentTerminalLayoutOptions[] = [];
  for (const side of SIDES) {
    for (const isOpen of BOOLS) {
      for (const isRunning of BOOLS) {
        for (const isWideMode of BOOLS) {
          for (const isBelowBreakpoint of BOOLS) {
            for (const isRightPanelOpen of BOOLS) {
              cases.push({
                showControls: true,
                isOpen,
                isRunning,
                isWideMode,
                isBelowBreakpoint,
                side,
                isRightPanelOpen,
              });
            }
          }
        }
      }
    }
  }
  return cases;
}

const label = (o: AgentTerminalLayoutOptions) =>
  `side=${o.side} open=${o.isOpen} running=${o.isRunning} wide=${o.isWideMode} ` +
  `belowBreakpoint=${o.isBelowBreakpoint} rightPanelOpen=${o.isRightPanelOpen}`;

describe('getAgentTerminalLayout — invariants across the full option table', () => {
  test('the panel is never docked on both edges at once', () => {
    // Two dock slots would mount AnnotateAgentTerminalPanel twice, i.e. two PTYs.
    for (const o of everyCase()) {
      const l = getAgentTerminalLayout(o);
      expect(l.showOnLeft && l.showOnRight, label(o)).toBe(false);
    }
  });

  test('a visible panel is always a rendered panel', () => {
    // Otherwise the shell reserves a dock slot for a component it never mounts.
    for (const o of everyCase()) {
      const l = getAgentTerminalLayout(o);
      if (l.isVisible) expect(l.shouldRender, label(o)).toBe(true);
    }
  });

  test('wide mode and sub-lg viewports never show the panel', () => {
    // The panel itself is `hidden lg:flex`; a visible dock would reserve width
    // for a box the browser refuses to paint.
    for (const o of everyCase()) {
      if (!o.isWideMode && !o.isBelowBreakpoint) continue;
      expect(getAgentTerminalLayout(o).isVisible, label(o)).toBe(false);
    }
  });

  test('a closed, idle terminal is not rendered on any side', () => {
    for (const o of everyCase()) {
      if (o.isOpen || o.isRunning) continue;
      const l = getAgentTerminalLayout(o);
      expect(l.shouldRender, label(o)).toBe(false);
      expect(l.showOnLeft || l.showOnRight, label(o)).toBe(false);
    }
  });

  test('a running terminal stays mounted while collapsed, off the layout', () => {
    // Unmounting a running panel kills the PTY the user is mid-conversation
    // with, so a collapsed-but-running terminal must render zero-width.
    for (const o of everyCase()) {
      const l = getAgentTerminalLayout(o);
      if (!l.shouldRender || l.isVisible) continue;
      expect(l.dockClassName, label(o)).toContain('w-0');
      expect(l.dockClassName, label(o)).toContain('pointer-events-none');
    }
  });

  test('the off-layout mount sits on the same edge it would dock against', () => {
    for (const o of everyCase()) {
      const l = getAgentTerminalLayout(o);
      if (l.isVisible) continue;
      expect(l.dockClassName, label(o)).toContain(
        l.placement === 'left' ? 'left-0' : 'right-0',
      );
    }
  });

  test('the right panel is suppressed exactly when a VISIBLE right terminal holds the slot', () => {
    // The bug this guards: an off-layout (collapsed or sub-breakpoint) terminal
    // must not blank the annotations/AI panel, and a visible one must, because
    // the two share the right-hand slot.
    for (const o of everyCase()) {
      const l = getAgentTerminalLayout(o);
      const rightTerminalHoldsSlot = l.isVisible && l.placement === 'right';
      expect(l.isRightPanelVisible, label(o)).toBe(
        o.isRightPanelOpen && !rightTerminalHoldsSlot,
      );
    }
  });

  test('the left rail flag tracks a visible left-docked terminal only', () => {
    for (const o of everyCase()) {
      const l = getAgentTerminalLayout(o);
      expect(l.isLeftVisible, label(o)).toBe(l.isVisible && l.placement === 'left');
    }
  });

  test('showControls=false renders nothing, whatever else is true', () => {
    for (const o of everyCase()) {
      const l = getAgentTerminalLayout({ ...o, showControls: false });
      expect(l.shouldRender, label(o)).toBe(false);
      expect(l.isVisible, label(o)).toBe(false);
      expect(l.isRightPanelVisible, label(o)).toBe(o.isRightPanelOpen);
    }
  });
});

describe('getAgentTerminalLayout — the hidden preference', () => {
  test('hidden owns no dock slot, so it never docks on the right', () => {
    for (const o of everyCase()) {
      if (o.side !== 'hidden') continue;
      const l = getAgentTerminalLayout(o);
      expect(l.showOnRight, label(o)).toBe(false);
      expect(l.placement, label(o)).toBe('left');
      expect(l.isHidden, label(o)).toBe(true);
    }
  });

  test('an explicit session open still docks the panel while hidden', () => {
    // Hidden is a default, not a lock: the rail toggle and Shift Shift arrive
    // here as isOpen and must still produce a real dock slot.
    const l = getAgentTerminalLayout({
      showControls: true,
      isOpen: true,
      isRunning: false,
      isWideMode: false,
      isBelowBreakpoint: false,
      side: 'hidden',
      isRightPanelOpen: false,
    });
    expect(l.isVisible).toBe(true);
    expect(l.showOnLeft).toBe(true);
    expect(l.isLeftVisible).toBe(true);
  });

  test('hidden lays out identically to left once open (it falls back to the historic edge)', () => {
    for (const o of everyCase()) {
      if (o.side !== 'hidden') continue;
      const hidden = getAgentTerminalLayout(o);
      const left = getAgentTerminalLayout({ ...o, side: 'left' });
      expect({ ...hidden, isHidden: false }, label(o)).toEqual(left);
    }
  });

  test('an unrecognized stored side degrades to left rather than vanishing', () => {
    const l = getAgentTerminalLayout({
      showControls: true,
      isOpen: true,
      isRunning: false,
      isWideMode: false,
      isBelowBreakpoint: false,
      side: 'bottom' as AnnotateAgentTerminalSide,
      isRightPanelOpen: true,
    });
    expect(l.placement).toBe('left');
    expect(l.isHidden).toBe(false);
    expect(l.isRightPanelVisible).toBe(true);
  });
});
