/**
 * useTextSelection - Hook for handling text selection on mobile
 *
 * IMPORTANT: React Native doesn't have a native text selection API like web.
 * This hook provides a simplified approach using long-press gestures.
 *
 * For proper text highlighting, integrate with:
 * - rn-text-touch-highlight (recommended)
 * - react-native-highlighter
 *
 * Current approach: Long-press on a block selects the entire block.
 */

import { useState, useCallback, useRef } from 'react';
import { GestureResponderEvent, NativeSyntheticEvent, TextLayoutEventData } from 'react-native';
import { Block } from '@plannotator/core';
import { SelectionRange, ToolbarPosition } from '../types';

export interface UseTextSelectionReturn {
  // Current selection state
  selection: SelectionRange | null;
  toolbarPosition: ToolbarPosition | null;
  isSelecting: boolean;

  // Handlers
  handleLongPress: (block: Block, event: GestureResponderEvent) => void;
  handleTextLayout: (block: Block, event: NativeSyntheticEvent<TextLayoutEventData>) => void;
  clearSelection: () => void;

  // For rn-text-touch-highlight integration
  handleHighlight: (range: { start: number; end: number; text: string }, blockId: string) => void;
}

interface TextLayoutCache {
  [blockId: string]: {
    lines: Array<{ x: number; y: number; width: number; height: number; text: string }>;
    pageX: number;
    pageY: number;
  };
}

export function useTextSelection(): UseTextSelectionReturn {
  const [selection, setSelection] = useState<SelectionRange | null>(null);
  const [toolbarPosition, setToolbarPosition] = useState<ToolbarPosition | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);

  // Cache text layouts for position calculation
  const textLayoutCache = useRef<TextLayoutCache>({});

  /**
   * Handle long-press on a block (simplified: selects entire block)
   */
  const handleLongPress = useCallback(
    (block: Block, event: GestureResponderEvent) => {
      const { pageX, pageY } = event.nativeEvent;

      setSelection({
        start: 0,
        end: block.content.length,
        text: block.content,
        blockId: block.id,
      });

      // Position toolbar above the press point
      setToolbarPosition({
        x: Math.max(0, pageX - 80), // Center the toolbar
        y: pageY - 60,
        width: 160,
      });

      setIsSelecting(true);
    },
    []
  );

  /**
   * Cache text layout for later position calculations
   */
  const handleTextLayout = useCallback(
    (block: Block, event: NativeSyntheticEvent<TextLayoutEventData>) => {
      const { lines } = event.nativeEvent;

      // Note: In real usage, also need to measure the view's page position
      textLayoutCache.current[block.id] = {
        lines: lines.map(line => ({
          x: line.x,
          y: line.y,
          width: line.width,
          height: line.height,
          text: line.text,
        })),
        pageX: 0, // Would need ref.measure() to get this
        pageY: 0,
      };
    },
    []
  );

  /**
   * Clear current selection
   */
  const clearSelection = useCallback(() => {
    setSelection(null);
    setToolbarPosition(null);
    setIsSelecting(false);
  }, []);

  /**
   * Handle highlight from rn-text-touch-highlight library
   * This is the integration point for proper text selection
   */
  const handleHighlight = useCallback(
    (range: { start: number; end: number; text: string }, blockId: string) => {
      setSelection({
        start: range.start,
        end: range.end,
        text: range.text,
        blockId,
      });

      // Note: rn-text-touch-highlight provides position info
      // For now, use a default position (would need actual position from library)
      setToolbarPosition({
        x: 100,
        y: 100,
        width: 160,
      });

      setIsSelecting(true);
    },
    []
  );

  return {
    selection,
    toolbarPosition,
    isSelecting,
    handleLongPress,
    handleTextLayout,
    clearSelection,
    handleHighlight,
  };
}

/**
 * Example usage with rn-text-touch-highlight:
 *
 * ```tsx
 * import { HighlightableText } from 'rn-text-touch-highlight';
 *
 * const { handleHighlight, selection } = useTextSelection();
 *
 * <HighlightableText
 *   text={block.content}
 *   onHighlight={(range) => handleHighlight(range, block.id)}
 *   highlights={annotations.map(a => ({
 *     start: a.startOffset,
 *     end: a.endOffset,
 *     style: { backgroundColor: '#fee2e2' }
 *   }))}
 * />
 * ```
 */
