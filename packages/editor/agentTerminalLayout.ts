// Via @plannotator/ui, which is how this package reaches shared code —
// @plannotator/core is not one of its direct dependencies.
import {
  resolveAnnotateAgentTerminalPlacement,
  type AnnotateAgentTerminalPlacement,
  type AnnotateAgentTerminalSide,
} from '@plannotator/ui/utils/annotateAgentTerminal';

/**
 * The Agent TUI panel is `hidden lg:flex`, so below Tailwind's `lg` breakpoint
 * it has no box at all. Layout must agree with that or it reserves width for a
 * panel nobody can see.
 */
export const AGENT_TERMINAL_LG_BREAKPOINT = 1024;

export type AgentTerminalLayoutOptions = {
  /** Whether this session offers the Agent TUI at all (annotate mode, capability present). */
  showControls: boolean;
  isOpen: boolean;
  isRunning: boolean;
  isWideMode: boolean;
  isBelowBreakpoint: boolean;
  /** The user's durable preference, which may be `hidden`. */
  side: AnnotateAgentTerminalSide;
  isRightPanelOpen: boolean;
};

export type AgentTerminalLayout = {
  /** Mount the panel (it may be mounted off-layout to keep a session alive). */
  shouldRender: boolean;
  /** The panel actually occupies its dock slot. */
  isVisible: boolean;
  isLeftVisible: boolean;
  showOnLeft: boolean;
  showOnRight: boolean;
  /** The right-hand annotations/AI panel is not being displaced by the terminal. */
  isRightPanelVisible: boolean;
  dockClassName: string;
  placement: AnnotateAgentTerminalPlacement;
  isHidden: boolean;
};

/**
 * Resolve everything the annotate shell needs to place the Agent TUI.
 *
 * `hidden` is a preference about the DEFAULT layout, not a lock: the rail
 * toggle, the Shift Shift shortcut and Settings all still open the panel for
 * the current session, and that session open arrives here as `isOpen`. So
 * `hidden` owns no dock slot of its own and an explicit open falls back to the
 * historic left placement. The App is what closes an open terminal when the
 * preference flips to `hidden`; this function stays pure.
 *
 * The terminal and the annotations/AI panel share the right-hand slot. A
 * VISIBLE right-docked terminal displaces the panel — but only visually, via
 * `isRightPanelVisible`. The panel's own open state is left untouched so
 * dismissing the terminal restores whatever the user had open. See the
 * invariant comment in App.tsx's right-slot handlers.
 */
export function getAgentTerminalLayout({
  showControls,
  isOpen,
  isRunning,
  isWideMode,
  isBelowBreakpoint,
  side,
  isRightPanelOpen,
}: AgentTerminalLayoutOptions): AgentTerminalLayout {
  const placement = resolveAnnotateAgentTerminalPlacement(side);
  const isHidden = side === 'hidden';
  // A running agent stays mounted even while collapsed, so hiding the panel
  // never kills the PTY the user is talking to.
  const shouldRender = showControls && (isOpen || isRunning);
  const isVisible = shouldRender && isOpen && !isWideMode && !isBelowBreakpoint;
  const isLeft = placement === 'left';
  const isLeftVisible = isVisible && isLeft;
  const isRightVisible = isVisible && !isLeft;
  const hiddenPositionClass = isLeft ? 'left-0' : 'right-0';
  const wrapperClassName = isVisible
    ? 'flex h-full flex-shrink-0 group/agent-terminal'
    : `absolute ${hiddenPositionClass} top-0 h-full w-0 overflow-hidden pointer-events-none group/agent-terminal`;
  const directionClassName = isLeft ? 'flex-row' : 'flex-row-reverse';

  return {
    shouldRender,
    isVisible,
    isLeftVisible,
    showOnLeft: shouldRender && isLeft,
    showOnRight: shouldRender && !isLeft,
    isRightPanelVisible: isRightPanelOpen && !isRightVisible,
    dockClassName: `${wrapperClassName} ${directionClassName}`,
    placement,
    isHidden,
  };
}
