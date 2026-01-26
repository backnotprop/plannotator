/**
 * CodeBlock - Renders code blocks with syntax highlighting
 * Uses react-native-syntax-highlighter for highlighting
 */

import React, { useState, useCallback, useMemo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Block } from '@plannotator/core';
import { PlannotatorTheme, lightTheme } from '../types';

// Note: In actual Happy integration, use:
// import SyntaxHighlighter from 'react-native-syntax-highlighter';
// import { atomOneDark } from 'react-syntax-highlighter/styles/hljs';

interface CodeBlockProps {
  block: Block;
  theme?: PlannotatorTheme;
  onCopy?: (content: string) => void;
  testID?: string;
}

export const CodeBlock: React.FC<CodeBlockProps> = ({
  block,
  theme = lightTheme,
  onCopy,
  testID,
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      // Note: In Happy, use Clipboard.setStringAsync from expo-clipboard
      onCopy?.(block.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [block.content, onCopy]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          marginVertical: 12,
          borderRadius: 8,
          backgroundColor: theme.surface,
          borderWidth: 1,
          borderColor: theme.border,
          overflow: 'hidden',
        },
        header: {
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingHorizontal: 12,
          paddingVertical: 8,
          backgroundColor: theme.border,
        },
        language: {
          fontSize: 12,
          color: theme.textMuted,
          fontFamily: 'monospace',
        },
        copyButton: {
          paddingHorizontal: 8,
          paddingVertical: 4,
          borderRadius: 4,
          backgroundColor: theme.surface,
        },
        copyButtonText: {
          fontSize: 12,
          color: copied ? theme.success : theme.textMuted,
        },
        codeContainer: {
          padding: 12,
        },
        code: {
          fontFamily: 'monospace',
          fontSize: 13,
          lineHeight: 20,
          color: theme.text,
        },
      }),
    [theme, copied]
  );

  return (
    <View style={styles.container} testID={testID}>
      {/* Header with language and copy button */}
      <View style={styles.header}>
        <Text style={styles.language}>
          {block.language || 'code'}
        </Text>
        <Pressable style={styles.copyButton} onPress={handleCopy}>
          <Text style={styles.copyButtonText}>
            {copied ? '✓ Copied' : 'Copy'}
          </Text>
        </Pressable>
      </View>

      {/* Code content */}
      <View style={styles.codeContainer}>
        {/*
          In actual Happy integration, replace with:
          <SyntaxHighlighter
            language={block.language || 'plaintext'}
            style={atomOneDark}
            fontSize={13}
          >
            {block.content}
          </SyntaxHighlighter>
        */}
        <Text style={styles.code} selectable>
          {block.content}
        </Text>
      </View>
    </View>
  );
};
