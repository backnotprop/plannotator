import {
  resolveAnnotateAgentTerminalPlacement,
  type AnnotateAgentTerminalPlacement,
  type AnnotateAgentTerminalSide,
} from '@plannotator/ui/utils/annotateAgentTerminal';

export const AGENT_TERMINAL_LG_BREAKPOINT = 1024;

export type AgentTerminalLayoutOptions = {
  showControls: boolean;
  isOpen: boolean;
  isRunning: boolean;
  isWideMode: boolean;
  isBelowBreakpoint: boolean;
  side: AnnotateAgentTerminalSide;
  isRightPanelOpen: boolean;
};

export type AgentTerminalLayout = {
  shouldRender: boolean;
  isVisible: boolean;
  isLeftVisible: boolean;
  showOnLeft: boolean;
  showOnRight: boolean;
  isRightPanelVisible: boolean;
  dockClassName: string;
  placement: AnnotateAgentTerminalPlacement;
  isHidden: boolean;
};

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
