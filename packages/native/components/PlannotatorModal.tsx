/**
 * PlannotatorModal - Full-screen modal for plan review
 * Combines PlanViewer, AnnotationPanel, and action buttons
 */

import React, { useMemo, useCallback, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  SafeAreaView,
  StyleSheet,
  useColorScheme,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import { parseMarkdownToBlocks, exportDiff, EditorMode } from '@plannotator/core';
import { PlanViewer } from './PlanViewer';
import { AnnotationPanel } from './AnnotationPanel';
import { useAnnotations } from '../hooks/useAnnotations';
import { usePlanReview } from '../hooks/usePlanReview';
import { PlannotatorTheme, lightTheme, darkTheme } from '../types';

interface PlannotatorModalProps {
  visible: boolean;
  onClose: () => void;
  planMarkdown: string;
  sessionId?: string;
  apiEndpoint?: string;
  onApprove?: () => void;
  onSendFeedback?: (feedback: string) => void;
  testID?: string;
}

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const PANEL_HEIGHT = SCREEN_HEIGHT * 0.35;

export const PlannotatorModal: React.FC<PlannotatorModalProps> = ({
  visible,
  onClose,
  planMarkdown,
  sessionId,
  apiEndpoint,
  onApprove,
  onSendFeedback,
  testID,
}) => {
  // Theme based on system preference
  const colorScheme = useColorScheme();
  const theme: PlannotatorTheme = colorScheme === 'dark' ? darkTheme : lightTheme;

  // State
  const [mode, setMode] = useState<EditorMode>('selection');
  const [showPanel, setShowPanel] = useState(true);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);

  // Parse markdown into blocks
  const blocks = useMemo(
    () => parseMarkdownToBlocks(planMarkdown),
    [planMarkdown]
  );

  // Annotations state
  const {
    annotations,
    addAnnotation,
    removeAnnotation,
    annotationCount,
  } = useAnnotations();

  // Review actions
  const { isSubmitting, approve, sendFeedback } = usePlanReview({
    sessionId,
    apiEndpoint,
  });

  // Handle approve
  const handleApprove = useCallback(async () => {
    await approve();
    onApprove?.();
    onClose();
  }, [approve, onApprove, onClose]);

  // Handle send feedback
  const handleSendFeedback = useCallback(async () => {
    const result = await sendFeedback(blocks, annotations);
    onSendFeedback?.(result.feedback || '');
    onClose();
  }, [sendFeedback, blocks, annotations, onSendFeedback, onClose]);

  // Copy to clipboard (placeholder - needs expo-clipboard in Happy)
  const handleCopy = useCallback((content: string) => {
    console.log('Copy:', content.slice(0, 100) + '...');
    // In Happy: Clipboard.setStringAsync(content);
  }, []);

  // Toggle mode
  const toggleMode = useCallback(() => {
    setMode(m => (m === 'selection' ? 'redline' : 'selection'));
  }, []);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          flex: 1,
          backgroundColor: theme.background,
        },
        header: {
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderBottomColor: theme.border,
          backgroundColor: theme.surface,
        },
        headerLeft: {
          flexDirection: 'row',
          alignItems: 'center',
        },
        closeButton: {
          padding: 4,
        },
        closeButtonText: {
          fontSize: 16,
          color: theme.primary,
        },
        title: {
          fontSize: 16,
          fontWeight: '600',
          color: theme.text,
          marginLeft: 12,
        },
        headerRight: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
        },
        modeButton: {
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderRadius: 6,
          backgroundColor: theme.background,
          borderWidth: 1,
          borderColor: theme.border,
        },
        modeButtonActive: {
          backgroundColor: theme.deletion,
          borderColor: theme.deletion,
        },
        modeButtonText: {
          fontSize: 12,
          color: theme.textMuted,
        },
        modeButtonTextActive: {
          color: '#dc2626',
          fontWeight: '500',
        },
        panelButton: {
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderRadius: 6,
          backgroundColor: theme.background,
          borderWidth: 1,
          borderColor: theme.border,
          flexDirection: 'row',
          alignItems: 'center',
        },
        panelButtonText: {
          fontSize: 12,
          color: theme.textMuted,
        },
        badge: {
          backgroundColor: theme.primary,
          borderRadius: 10,
          paddingHorizontal: 6,
          paddingVertical: 2,
          marginLeft: 6,
        },
        badgeText: {
          fontSize: 10,
          color: '#ffffff',
          fontWeight: '600',
        },
        content: {
          flex: 1,
        },
        viewer: {
          flex: 1,
        },
        panel: {
          height: PANEL_HEIGHT,
          borderTopWidth: 1,
          borderTopColor: theme.border,
        },
        footer: {
          flexDirection: 'row',
          justifyContent: 'flex-end',
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingVertical: 12,
          borderTopWidth: 1,
          borderTopColor: theme.border,
          backgroundColor: theme.surface,
          gap: 12,
        },
        feedbackButton: {
          paddingHorizontal: 16,
          paddingVertical: 10,
          borderRadius: 8,
          backgroundColor: theme.comment,
          flexDirection: 'row',
          alignItems: 'center',
        },
        feedbackButtonDisabled: {
          opacity: 0.5,
        },
        feedbackButtonText: {
          fontSize: 14,
          fontWeight: '500',
          color: '#92400e',
        },
        approveButton: {
          paddingHorizontal: 16,
          paddingVertical: 10,
          borderRadius: 8,
          backgroundColor: theme.success,
          flexDirection: 'row',
          alignItems: 'center',
        },
        approveButtonText: {
          fontSize: 14,
          fontWeight: '500',
          color: '#ffffff',
        },
        loadingIndicator: {
          marginRight: 8,
        },
      }),
    [theme]
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
      testID={testID}
    >
      <SafeAreaView style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Pressable style={styles.closeButton} onPress={onClose}>
              <Text style={styles.closeButtonText}>Cancel</Text>
            </Pressable>
            <Text style={styles.title}>Review Plan</Text>
          </View>

          <View style={styles.headerRight}>
            {/* Mode toggle */}
            <Pressable
              style={[styles.modeButton, mode === 'redline' && styles.modeButtonActive]}
              onPress={toggleMode}
            >
              <Text
                style={[
                  styles.modeButtonText,
                  mode === 'redline' && styles.modeButtonTextActive,
                ]}
              >
                {mode === 'redline' ? '🔴 Redline' : '✏️ Select'}
              </Text>
            </Pressable>

            {/* Panel toggle */}
            <Pressable
              style={styles.panelButton}
              onPress={() => setShowPanel(p => !p)}
            >
              <Text style={styles.panelButtonText}>
                {showPanel ? '⬇️ Panel' : '⬆️ Panel'}
              </Text>
              {annotationCount > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{annotationCount}</Text>
                </View>
              )}
            </Pressable>
          </View>
        </View>

        {/* Content area */}
        <View style={styles.content}>
          {/* Plan viewer */}
          <View style={[styles.viewer, showPanel && { flex: 0.65 }]}>
            <PlanViewer
              blocks={blocks}
              annotations={annotations}
              mode={mode}
              theme={theme}
              onAddAnnotation={addAnnotation}
              onSelectAnnotation={setSelectedAnnotationId}
              onCopy={handleCopy}
              testID={`${testID}-viewer`}
            />
          </View>

          {/* Annotation panel */}
          {showPanel && (
            <View style={styles.panel}>
              <AnnotationPanel
                annotations={annotations}
                selectedId={selectedAnnotationId}
                theme={theme}
                onSelect={setSelectedAnnotationId}
                onDelete={removeAnnotation}
                testID={`${testID}-panel`}
              />
            </View>
          )}
        </View>

        {/* Footer with action buttons */}
        <View style={styles.footer}>
          {/* Send Feedback button */}
          <Pressable
            style={[
              styles.feedbackButton,
              (isSubmitting || annotationCount === 0) && styles.feedbackButtonDisabled,
            ]}
            onPress={handleSendFeedback}
            disabled={isSubmitting || annotationCount === 0}
            testID={`${testID}-feedback-button`}
          >
            {isSubmitting && (
              <ActivityIndicator
                size="small"
                color="#92400e"
                style={styles.loadingIndicator}
              />
            )}
            <Text style={styles.feedbackButtonText}>
              Send Feedback ({annotationCount})
            </Text>
          </Pressable>

          {/* Approve button */}
          <Pressable
            style={styles.approveButton}
            onPress={handleApprove}
            disabled={isSubmitting}
            testID={`${testID}-approve-button`}
          >
            {isSubmitting && (
              <ActivityIndicator
                size="small"
                color="#ffffff"
                style={styles.loadingIndicator}
              />
            )}
            <Text style={styles.approveButtonText}>Approve ✓</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </Modal>
  );
};
