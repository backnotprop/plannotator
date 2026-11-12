import { describe, expect, test } from 'bun:test';
import { MERMAID_CONFIG } from './MermaidBlock';

describe('MERMAID_CONFIG', () => {
  test('keeps securityLevel strict and startOnLoad off', () => {
    expect(MERMAID_CONFIG.securityLevel).toBe('strict');
    expect(MERMAID_CONFIG.startOnLoad).toBe(false);
  });
});
