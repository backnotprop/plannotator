/**
 * BlockRenderer - Renders a single markdown block
 * Handles all block types: heading, paragraph, code, list-item, blockquote, hr, table
 */

import React, { useMemo, useCallback } from 'react';
import { View, Text, StyleSheet, Pressable, ViewStyle } from 'react-native';
import { Block, Annotation, AnnotationType } from '@plannotator/core';
import { InlineMarkdown } from './InlineMarkdown';
import { CodeBlock } from './CodeBlock';
import { PlannotatorTheme, lightTheme, SelectionRange } from '../types';

interface BlockRendererProps {
  block: Block;
  annotations: Annotation[];
  theme?: PlannotatorTheme;
  onTextSelect?: (range: SelectionRange) => void;
  onCopy?: (content: string) => void;
  testID?: string;
}

// Helper to get highlight style for annotation type
function getHighlightStyle(type: AnnotationType, theme: PlannotatorTheme): ViewStyle {
  switch (type) {
    case AnnotationType.DELETION:
      return { backgroundColor: theme.deletion };
    case AnnotationType.COMMENT:
    case AnnotationType.REPLACEMENT:
    case AnnotationType.INSERTION:
      return { backgroundColor: theme.comment };
    default:
      return {};
  }
}

// Helper to parse table content
function parseTable(content: string): { headers: string[]; rows: string[][] } {
  const lines = content.split('\n').filter(line => line.trim());
  if (lines.length === 0) return { headers: [], rows: [] };

  const parseRow = (line: string): string[] =>
    line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map(cell => cell.trim());

  const headers = parseRow(lines[0]);
  const rows: string[][] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^[\|\-:\s]+$/.test(line)) continue; // Skip separator
    rows.push(parseRow(line));
  }

  return { headers, rows };
}

export const BlockRenderer: React.FC<BlockRendererProps> = ({
  block,
  annotations,
  theme = lightTheme,
  onTextSelect,
  onCopy,
  testID,
}) => {
  const styles = useMemo(
    () =>
      StyleSheet.create({
        // Headings
        h1: {
          fontSize: 24,
          fontWeight: 'bold',
          marginTop: 24,
          marginBottom: 16,
          color: theme.text,
        },
        h2: {
          fontSize: 20,
          fontWeight: '600',
          marginTop: 20,
          marginBottom: 12,
          color: theme.text,
        },
        h3: {
          fontSize: 18,
          fontWeight: '600',
          marginTop: 16,
          marginBottom: 8,
          color: theme.text,
        },
        // Paragraph
        paragraph: {
          marginVertical: 8,
        },
        // List item
        listItemContainer: {
          flexDirection: 'row',
          marginVertical: 4,
        },
        listItemBullet: {
          width: 20,
          marginRight: 8,
          color: theme.primary,
        },
        listItemContent: {
          flex: 1,
        },
        checkbox: {
          marginRight: 8,
        },
        checkedText: {
          textDecorationLine: 'line-through',
          color: theme.textMuted,
        },
        // Blockquote
        blockquote: {
          borderLeftWidth: 3,
          borderLeftColor: theme.primary,
          paddingLeft: 12,
          marginVertical: 8,
        },
        blockquoteText: {
          fontStyle: 'italic',
          color: theme.textMuted,
        },
        // Horizontal rule
        hr: {
          height: 1,
          backgroundColor: theme.border,
          marginVertical: 24,
        },
        // Table
        table: {
          marginVertical: 12,
          borderWidth: 1,
          borderColor: theme.border,
          borderRadius: 8,
          overflow: 'hidden',
        },
        tableRow: {
          flexDirection: 'row',
          borderBottomWidth: 1,
          borderBottomColor: theme.border,
        },
        tableHeader: {
          flex: 1,
          padding: 8,
          backgroundColor: theme.surface,
        },
        tableHeaderText: {
          fontWeight: '600',
          color: theme.text,
        },
        tableCell: {
          flex: 1,
          padding: 8,
        },
        tableCellText: {
          color: theme.text,
        },
        // Highlighted text
        highlighted: {
          borderRadius: 2,
        },
      }),
    [theme]
  );

  // Render text with highlights for annotations
  const renderHighlightedText = useCallback(
    (content: string, blockAnnotations: Annotation[]) => {
      if (blockAnnotations.length === 0) {
        return <InlineMarkdown text={content} theme={theme} />;
      }

      // Sort annotations by start offset
      const sorted = [...blockAnnotations].sort((a, b) => a.startOffset - b.startOffset);

      const parts: React.ReactNode[] = [];
      let lastIndex = 0;

      sorted.forEach((ann, idx) => {
        // Text before annotation
        if (ann.startOffset > lastIndex) {
          parts.push(
            <InlineMarkdown
              key={`text-${idx}`}
              text={content.slice(lastIndex, ann.startOffset)}
              theme={theme}
            />
          );
        }

        // Highlighted text
        parts.push(
          <Text
            key={`ann-${ann.id}`}
            style={[styles.highlighted, getHighlightStyle(ann.type, theme)]}
          >
            {content.slice(ann.startOffset, ann.endOffset)}
          </Text>
        );

        lastIndex = ann.endOffset;
      });

      // Remaining text
      if (lastIndex < content.length) {
        parts.push(
          <InlineMarkdown key="text-end" text={content.slice(lastIndex)} theme={theme} />
        );
      }

      return <Text>{parts}</Text>;
    },
    [theme, styles.highlighted]
  );

  // Block-specific renderers
  switch (block.type) {
    case 'heading': {
      const headingStyle =
        block.level === 1 ? styles.h1 : block.level === 2 ? styles.h2 : styles.h3;

      return (
        <Pressable testID={testID}>
          <Text style={headingStyle}>
            {renderHighlightedText(block.content, annotations)}
          </Text>
        </Pressable>
      );
    }

    case 'code':
      return <CodeBlock block={block} theme={theme} onCopy={onCopy} testID={testID} />;

    case 'list-item': {
      const indent = (block.level || 0) * 16;
      const isCheckbox = block.checked !== undefined;
      const bullet = isCheckbox
        ? block.checked
          ? '☑'
          : '☐'
        : block.level === 0
        ? '•'
        : block.level === 1
        ? '◦'
        : '▪';

      return (
        <View style={[styles.listItemContainer, { marginLeft: indent }]} testID={testID}>
          <Text style={styles.listItemBullet}>{bullet}</Text>
          <View style={styles.listItemContent}>
            <Text style={isCheckbox && block.checked ? styles.checkedText : undefined}>
              {renderHighlightedText(block.content, annotations)}
            </Text>
          </View>
        </View>
      );
    }

    case 'blockquote':
      return (
        <View style={styles.blockquote} testID={testID}>
          <Text style={styles.blockquoteText}>
            {renderHighlightedText(block.content, annotations)}
          </Text>
        </View>
      );

    case 'hr':
      return <View style={styles.hr} testID={testID} />;

    case 'table': {
      const { headers, rows } = parseTable(block.content);

      return (
        <View style={styles.table} testID={testID}>
          {/* Header row */}
          <View style={styles.tableRow}>
            {headers.map((header, i) => (
              <View key={i} style={styles.tableHeader}>
                <InlineMarkdown text={header} theme={theme} style={styles.tableHeaderText} />
              </View>
            ))}
          </View>

          {/* Data rows */}
          {rows.map((row, rowIdx) => (
            <View
              key={rowIdx}
              style={[
                styles.tableRow,
                rowIdx === rows.length - 1 && { borderBottomWidth: 0 },
              ]}
            >
              {row.map((cell, cellIdx) => (
                <View key={cellIdx} style={styles.tableCell}>
                  <InlineMarkdown text={cell} theme={theme} style={styles.tableCellText} />
                </View>
              ))}
            </View>
          ))}
        </View>
      );
    }

    default:
      // Paragraph
      return (
        <Pressable style={styles.paragraph} testID={testID}>
          {renderHighlightedText(block.content, annotations)}
        </Pressable>
      );
  }
};
