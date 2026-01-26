/**
 * AnnotationPanel - Bottom sheet showing list of annotations
 * Displays all annotations with delete/edit capabilities
 */

import React, { useMemo, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
} from 'react-native';
import { Annotation, AnnotationType } from '@plannotator/core';
import { PlannotatorTheme, lightTheme } from '../types';

interface AnnotationPanelProps {
  annotations: Annotation[];
  selectedId: string | null;
  theme?: PlannotatorTheme;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  testID?: string;
}

// Format timestamp to relative time
function formatTimestamp(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

// Get annotation type label
function getTypeLabel(type: AnnotationType): string {
  switch (type) {
    case AnnotationType.DELETION:
      return '🗑 Deletion';
    case AnnotationType.COMMENT:
      return '💬 Comment';
    case AnnotationType.REPLACEMENT:
      return '✏️ Replacement';
    case AnnotationType.INSERTION:
      return '➕ Insertion';
    case AnnotationType.GLOBAL_COMMENT:
      return '🌍 Global Comment';
    default:
      return 'Annotation';
  }
}

// Get type color
function getTypeColor(type: AnnotationType, theme: PlannotatorTheme): string {
  switch (type) {
    case AnnotationType.DELETION:
      return theme.deletion;
    case AnnotationType.COMMENT:
    case AnnotationType.REPLACEMENT:
    case AnnotationType.INSERTION:
    case AnnotationType.GLOBAL_COMMENT:
      return theme.comment;
    default:
      return theme.surface;
  }
}

export const AnnotationPanel: React.FC<AnnotationPanelProps> = ({
  annotations,
  selectedId,
  theme = lightTheme,
  onSelect,
  onDelete,
  testID,
}) => {
  const sortedAnnotations = useMemo(
    () => [...annotations].sort((a, b) => a.createdAt - b.createdAt),
    [annotations]
  );

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
          padding: 16,
          borderBottomWidth: 1,
          borderBottomColor: theme.border,
        },
        headerTitle: {
          fontSize: 16,
          fontWeight: '600',
          color: theme.text,
        },
        headerCount: {
          fontSize: 14,
          color: theme.textMuted,
        },
        emptyContainer: {
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          padding: 32,
        },
        emptyText: {
          fontSize: 14,
          color: theme.textMuted,
          textAlign: 'center',
          marginTop: 8,
        },
        emptyIcon: {
          fontSize: 32,
          marginBottom: 8,
        },
        annotationItem: {
          padding: 12,
          borderBottomWidth: 1,
          borderBottomColor: theme.border,
        },
        annotationItemSelected: {
          backgroundColor: theme.surface,
        },
        annotationHeader: {
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 4,
        },
        annotationType: {
          flexDirection: 'row',
          alignItems: 'center',
        },
        typeIndicator: {
          width: 8,
          height: 8,
          borderRadius: 4,
          marginRight: 8,
        },
        typeLabel: {
          fontSize: 12,
          fontWeight: '500',
          color: theme.textMuted,
        },
        timestamp: {
          fontSize: 11,
          color: theme.textMuted,
        },
        originalText: {
          fontSize: 13,
          color: theme.text,
          marginTop: 4,
        },
        originalTextTruncated: {
          maxHeight: 40,
          overflow: 'hidden',
        },
        commentText: {
          fontSize: 13,
          color: theme.primary,
          fontStyle: 'italic',
          marginTop: 4,
        },
        actions: {
          flexDirection: 'row',
          justifyContent: 'flex-end',
          marginTop: 8,
        },
        deleteButton: {
          paddingHorizontal: 12,
          paddingVertical: 4,
          borderRadius: 4,
          backgroundColor: '#fef2f2',
        },
        deleteButtonText: {
          fontSize: 12,
          color: '#dc2626',
        },
        authorBadge: {
          fontSize: 11,
          color: theme.textMuted,
          backgroundColor: theme.surface,
          paddingHorizontal: 6,
          paddingVertical: 2,
          borderRadius: 4,
          marginLeft: 8,
        },
      }),
    [theme]
  );

  const renderAnnotation = useCallback(
    ({ item }: { item: Annotation }) => {
      const isSelected = item.id === selectedId;

      return (
        <Pressable
          style={[styles.annotationItem, isSelected && styles.annotationItemSelected]}
          onPress={() => onSelect(item.id)}
          testID={`${testID}-item-${item.id}`}
        >
          <View style={styles.annotationHeader}>
            <View style={styles.annotationType}>
              <View
                style={[
                  styles.typeIndicator,
                  { backgroundColor: getTypeColor(item.type, theme) },
                ]}
              />
              <Text style={styles.typeLabel}>{getTypeLabel(item.type)}</Text>
              {item.author && (
                <Text style={styles.authorBadge}>{item.author}</Text>
              )}
            </View>
            <Text style={styles.timestamp}>{formatTimestamp(item.createdAt)}</Text>
          </View>

          {/* Original text (for non-global comments) */}
          {item.type !== AnnotationType.GLOBAL_COMMENT && item.originalText && (
            <Text
              style={[styles.originalText, styles.originalTextTruncated]}
              numberOfLines={2}
            >
              "{item.originalText}"
            </Text>
          )}

          {/* Comment/replacement text */}
          {item.text && (
            <Text style={styles.commentText} numberOfLines={3}>
              → {item.text}
            </Text>
          )}

          {/* Delete action */}
          <View style={styles.actions}>
            <Pressable
              style={styles.deleteButton}
              onPress={() => onDelete(item.id)}
              testID={`${testID}-delete-${item.id}`}
            >
              <Text style={styles.deleteButtonText}>Delete</Text>
            </Pressable>
          </View>
        </Pressable>
      );
    },
    [styles, selectedId, theme, onSelect, onDelete, testID]
  );

  const renderEmpty = useCallback(
    () => (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyIcon}>📝</Text>
        <Text style={styles.emptyText}>
          No annotations yet.{'\n'}
          Select text to add feedback.
        </Text>
      </View>
    ),
    [styles]
  );

  return (
    <View style={styles.container} testID={testID}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Annotations</Text>
        <Text style={styles.headerCount}>
          {annotations.length} item{annotations.length !== 1 ? 's' : ''}
        </Text>
      </View>

      <FlatList
        data={sortedAnnotations}
        renderItem={renderAnnotation}
        keyExtractor={item => item.id}
        ListEmptyComponent={renderEmpty}
      />
    </View>
  );
};
