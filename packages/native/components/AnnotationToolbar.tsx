/**
 * AnnotationToolbar - Floating toolbar for creating annotations
 * Appears above selected text with Copy, Delete, Comment actions
 */

import React, { useState, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Animated,
  Keyboard,
} from 'react-native';
import { AnnotationType } from '@plannotator/core';
import { PlannotatorTheme, lightTheme, ToolbarPosition } from '../types';

interface AnnotationToolbarProps {
  visible: boolean;
  position: ToolbarPosition;
  selectedText: string;
  theme?: PlannotatorTheme;
  onAnnotate: (type: AnnotationType, text?: string) => void;
  onCopy: () => void;
  onClose: () => void;
  testID?: string;
}

type ToolbarMode = 'actions' | 'comment';

export const AnnotationToolbar: React.FC<AnnotationToolbarProps> = ({
  visible,
  position,
  selectedText,
  theme = lightTheme,
  onAnnotate,
  onCopy,
  onClose,
  testID,
}) => {
  const [mode, setMode] = useState<ToolbarMode>('actions');
  const [commentText, setCommentText] = useState('');
  const [fadeAnim] = useState(new Animated.Value(0));

  // Animate in/out
  React.useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: visible ? 1 : 0,
      duration: 150,
      useNativeDriver: true,
    }).start();

    if (!visible) {
      setMode('actions');
      setCommentText('');
    }
  }, [visible, fadeAnim]);

  const handleCopy = useCallback(() => {
    onCopy();
    onClose();
  }, [onCopy, onClose]);

  const handleDelete = useCallback(() => {
    onAnnotate(AnnotationType.DELETION);
    onClose();
  }, [onAnnotate, onClose]);

  const handleComment = useCallback(() => {
    setMode('comment');
  }, []);

  const handleSubmitComment = useCallback(() => {
    if (commentText.trim()) {
      onAnnotate(AnnotationType.COMMENT, commentText.trim());
      setCommentText('');
      Keyboard.dismiss();
      onClose();
    }
  }, [commentText, onAnnotate, onClose]);

  const handleCancelComment = useCallback(() => {
    setMode('actions');
    setCommentText('');
    Keyboard.dismiss();
  }, []);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          position: 'absolute',
          left: position.x,
          top: position.y - 50, // Position above selection
          minWidth: 160,
          backgroundColor: theme.surface,
          borderRadius: 8,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.25,
          shadowRadius: 4,
          elevation: 5,
          borderWidth: 1,
          borderColor: theme.border,
        },
        actionsRow: {
          flexDirection: 'row',
          alignItems: 'center',
          padding: 4,
        },
        button: {
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: 4,
        },
        buttonPressed: {
          backgroundColor: theme.border,
        },
        buttonText: {
          fontSize: 14,
          color: theme.text,
        },
        deleteButton: {
          // Red tint for delete
        },
        deleteButtonText: {
          color: '#dc2626',
        },
        separator: {
          width: 1,
          height: 20,
          backgroundColor: theme.border,
          marginHorizontal: 4,
        },
        closeButton: {
          padding: 8,
        },
        closeButtonText: {
          fontSize: 16,
          color: theme.textMuted,
        },
        // Comment input mode
        commentContainer: {
          padding: 8,
          minWidth: 240,
        },
        commentInput: {
          backgroundColor: theme.background,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: theme.border,
          padding: 8,
          fontSize: 14,
          color: theme.text,
          minHeight: 60,
          maxHeight: 120,
          textAlignVertical: 'top',
        },
        commentActions: {
          flexDirection: 'row',
          justifyContent: 'flex-end',
          marginTop: 8,
          gap: 8,
        },
        cancelButton: {
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderRadius: 4,
        },
        cancelButtonText: {
          color: theme.textMuted,
          fontSize: 14,
        },
        submitButton: {
          backgroundColor: theme.primary,
          paddingHorizontal: 12,
          paddingVertical: 6,
          borderRadius: 4,
        },
        submitButtonDisabled: {
          opacity: 0.5,
        },
        submitButtonText: {
          color: '#ffffff',
          fontSize: 14,
          fontWeight: '500',
        },
      }),
    [theme, position]
  );

  if (!visible) return null;

  return (
    <Animated.View
      style={[styles.container, { opacity: fadeAnim }]}
      testID={testID}
    >
      {mode === 'actions' ? (
        <View style={styles.actionsRow}>
          {/* Copy button */}
          <Pressable
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
            onPress={handleCopy}
            testID={`${testID}-copy`}
          >
            <Text style={styles.buttonText}>📋 Copy</Text>
          </Pressable>

          <View style={styles.separator} />

          {/* Delete button */}
          <Pressable
            style={({ pressed }) => [
              styles.button,
              styles.deleteButton,
              pressed && styles.buttonPressed,
            ]}
            onPress={handleDelete}
            testID={`${testID}-delete`}
          >
            <Text style={[styles.buttonText, styles.deleteButtonText]}>🗑 Delete</Text>
          </Pressable>

          <View style={styles.separator} />

          {/* Comment button */}
          <Pressable
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
            onPress={handleComment}
            testID={`${testID}-comment`}
          >
            <Text style={styles.buttonText}>💬 Comment</Text>
          </Pressable>

          <View style={styles.separator} />

          {/* Close button */}
          <Pressable
            style={styles.closeButton}
            onPress={onClose}
            testID={`${testID}-close`}
          >
            <Text style={styles.closeButtonText}>✕</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.commentContainer}>
          <TextInput
            style={styles.commentInput}
            placeholder="Add a comment..."
            placeholderTextColor={theme.textMuted}
            value={commentText}
            onChangeText={setCommentText}
            multiline
            autoFocus
            testID={`${testID}-comment-input`}
          />
          <View style={styles.commentActions}>
            <Pressable style={styles.cancelButton} onPress={handleCancelComment}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[
                styles.submitButton,
                !commentText.trim() && styles.submitButtonDisabled,
              ]}
              onPress={handleSubmitComment}
              disabled={!commentText.trim()}
              testID={`${testID}-comment-submit`}
            >
              <Text style={styles.submitButtonText}>Add</Text>
            </Pressable>
          </View>
        </View>
      )}
    </Animated.View>
  );
};
