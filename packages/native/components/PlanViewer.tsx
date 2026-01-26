/**
 * PlanViewer - Main component for viewing and annotating a plan
 * Renders markdown blocks with annotation support
 */

import React, { useMemo, useCallback } from 'react';
import {
  ScrollView,
  View,
  Text,
  Pressable,
  StyleSheet,
  Platform,
} from 'react-native';
import { Block, Annotation, AnnotationType, EditorMode } from '@plannotator/core';
import { BlockRenderer } from './BlockRenderer';
import { AnnotationToolbar } from './AnnotationToolbar';
import { PlannotatorTheme, lightTheme, SelectionRange, ToolbarPosition } from '../types';
import { useTextSelection } from '../hooks/useTextSelection';

interface PlanViewerProps {
  blocks: Block[];
  annotations: Annotation[];
  mode: EditorMode;
  theme?: PlannotatorTheme;
  onAddAnnotation: (annotation: Annotation) => void;
  onSelectAnnotation?: (id: string) => void;
  onCopy?: (content: string) => void;
  testID?: string;
}

export const PlanViewer: React.FC<PlanViewerProps> = ({
  blocks,
  annotations,
  mode,
  theme = lightTheme,
  onAddAnnotation,
  onSelectAnnotation,
  onCopy,
  testID,
}) => {
  const {
    selection,
    toolbarPosition,
    isSelecting,
    handleLongPress,
    clearSelection,
  } = useTextSelection();

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          flex: 1,
          backgroundColor: theme.background,
        },
        scrollView: {
          flex: 1,
        },
        contentContainer: {
          padding: 16,
          paddingBottom: 100, // Space for bottom sheet
        },
        // Header buttons
        headerButtons: {
          flexDirection: 'row',
          justifyContent: 'flex-end',
          marginBottom: 8,
          gap: 8,
        },
        headerButton: {
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderRadius: 6,
          backgroundColor: theme.surface,
          borderWidth: 1,
          borderColor: theme.border,
        },
        headerButtonText: {
          fontSize: 12,
          color: theme.textMuted,
          marginLeft: 4,
        },
        // Mode indicator
        modeIndicator: {
          position: 'absolute',
          bottom: 16,
          left: 16,
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderRadius: 16,
          backgroundColor: mode === 'redline' ? theme.deletion : theme.comment,
        },
        modeIndicatorText: {
          fontSize: 12,
          fontWeight: '500',
          color: theme.text,
        },
        // Block wrapper for touch handling
        blockWrapper: {
          // Needed for proper touch handling
        },
      }),
    [theme, mode]
  );

  // Get annotations for a specific block
  const getBlockAnnotations = useCallback(
    (blockId: string) => annotations.filter(a => a.blockId === blockId),
    [annotations]
  );

  // Handle creating annotation from selection
  const handleAnnotate = useCallback(
    (type: AnnotationType, text?: string) => {
      if (!selection) return;

      const newAnnotation: Annotation = {
        id: `ann-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        blockId: selection.blockId,
        startOffset: selection.start,
        endOffset: selection.end,
        type,
        text,
        originalText: selection.text,
        createdAt: Date.now(),
      };

      onAddAnnotation(newAnnotation);
      clearSelection();
    },
    [selection, onAddAnnotation, clearSelection]
  );

  // Handle copy from toolbar
  const handleToolbarCopy = useCallback(() => {
    if (selection && onCopy) {
      onCopy(selection.text);
    }
    clearSelection();
  }, [selection, onCopy, clearSelection]);

  // Copy entire plan
  const handleCopyPlan = useCallback(() => {
    const fullText = blocks.map(b => b.content).join('\n\n');
    onCopy?.(fullText);
  }, [blocks, onCopy]);

  // Long press on a block
  const handleBlockLongPress = useCallback(
    (block: Block, event: any) => {
      if (mode === 'redline') {
        // In redline mode, auto-delete on selection
        const newAnnotation: Annotation = {
          id: `ann-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          blockId: block.id,
          startOffset: 0,
          endOffset: block.content.length,
          type: AnnotationType.DELETION,
          originalText: block.content,
          createdAt: Date.now(),
        };
        onAddAnnotation(newAnnotation);
      } else {
        // In selection mode, show toolbar
        handleLongPress(block, event);
      }
    },
    [mode, handleLongPress, onAddAnnotation]
  );

  return (
    <View style={styles.container} testID={testID}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.contentContainer}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header buttons */}
        <View style={styles.headerButtons}>
          <Pressable style={styles.headerButton} onPress={handleCopyPlan}>
            <Text>📋</Text>
            <Text style={styles.headerButtonText}>Copy plan</Text>
          </Pressable>
        </View>

        {/* Render blocks */}
        {blocks.map((block, index) => (
          <Pressable
            key={block.id}
            style={styles.blockWrapper}
            onLongPress={(event) => handleBlockLongPress(block, event)}
            delayLongPress={300}
          >
            <BlockRenderer
              block={block}
              annotations={getBlockAnnotations(block.id)}
              theme={theme}
              onCopy={onCopy}
              testID={`${testID}-block-${index}`}
            />
          </Pressable>
        ))}
      </ScrollView>

      {/* Annotation Toolbar (floating) */}
      {toolbarPosition && selection && (
        <AnnotationToolbar
          visible={isSelecting}
          position={toolbarPosition}
          selectedText={selection.text}
          theme={theme}
          onAnnotate={handleAnnotate}
          onCopy={handleToolbarCopy}
          onClose={clearSelection}
          testID={`${testID}-toolbar`}
        />
      )}

      {/* Mode indicator */}
      <View style={styles.modeIndicator}>
        <Text style={styles.modeIndicatorText}>
          {mode === 'redline' ? '🔴 Redline Mode' : '✏️ Selection Mode'}
        </Text>
      </View>
    </View>
  );
};
