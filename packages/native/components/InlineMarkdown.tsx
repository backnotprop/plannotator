/**
 * InlineMarkdown - Renders inline markdown formatting
 * Handles: **bold**, *italic*, `code`, [links](url)
 */

import React, { useMemo } from 'react';
import { Text, StyleSheet, Linking, TextStyle } from 'react-native';
import { PlannotatorTheme, lightTheme } from '../types';

interface InlineMarkdownProps {
  text: string;
  theme?: PlannotatorTheme;
  style?: TextStyle;
}

interface TextPart {
  type: 'text' | 'bold' | 'italic' | 'code' | 'link';
  content: string;
  url?: string;
}

function parseInlineMarkdown(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Bold: **text**
    let match = remaining.match(/^\*\*(.+?)\*\*/);
    if (match) {
      parts.push({ type: 'bold', content: match[1] });
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Italic: *text*
    match = remaining.match(/^\*(.+?)\*/);
    if (match) {
      parts.push({ type: 'italic', content: match[1] });
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Inline code: `code`
    match = remaining.match(/^`([^`]+)`/);
    if (match) {
      parts.push({ type: 'code', content: match[1] });
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Links: [text](url)
    match = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (match) {
      parts.push({ type: 'link', content: match[1], url: match[2] });
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Find next special character or consume one regular character
    const nextSpecial = remaining.slice(1).search(/[\*`\[]/);
    if (nextSpecial === -1) {
      parts.push({ type: 'text', content: remaining });
      break;
    } else {
      parts.push({ type: 'text', content: remaining.slice(0, nextSpecial + 1) });
      remaining = remaining.slice(nextSpecial + 1);
    }
  }

  return parts;
}

export const InlineMarkdown: React.FC<InlineMarkdownProps> = ({
  text,
  theme = lightTheme,
  style,
}) => {
  const parts = useMemo(() => parseInlineMarkdown(text), [text]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        text: {
          color: theme.text,
          fontSize: 15,
          lineHeight: 22,
          ...style,
        },
        bold: {
          fontWeight: '600',
        },
        italic: {
          fontStyle: 'italic',
        },
        code: {
          fontFamily: 'monospace',
          fontSize: 13,
          backgroundColor: theme.surface,
          paddingHorizontal: 4,
          paddingVertical: 2,
          borderRadius: 4,
        },
        link: {
          color: theme.primary,
          textDecorationLine: 'underline',
        },
      }),
    [theme, style]
  );

  const handleLinkPress = (url: string) => {
    Linking.openURL(url).catch(err => console.error('Failed to open URL:', err));
  };

  return (
    <Text style={styles.text}>
      {parts.map((part, index) => {
        switch (part.type) {
          case 'bold':
            return (
              <Text key={index} style={styles.bold}>
                {part.content}
              </Text>
            );
          case 'italic':
            return (
              <Text key={index} style={styles.italic}>
                {part.content}
              </Text>
            );
          case 'code':
            return (
              <Text key={index} style={styles.code}>
                {part.content}
              </Text>
            );
          case 'link':
            return (
              <Text
                key={index}
                style={styles.link}
                onPress={() => handleLinkPress(part.url!)}
              >
                {part.content}
              </Text>
            );
          default:
            return <Text key={index}>{part.content}</Text>;
        }
      })}
    </Text>
  );
};
