import { describe, expect, test } from 'bun:test';
import { MERMAID_CONFIG } from './MermaidBlock';

describe('MERMAID_CONFIG', () => {
  // Deliberate security pin: the config is applied on first diagram (the
  // runtime is imported lazily), so a drift here would only show up in the
  // browser as arbitrary HTML/JS in a document-supplied diagram.
  test('keeps securityLevel strict and startOnLoad off', () => {
    expect(MERMAID_CONFIG.securityLevel).toBe('strict');
    expect(MERMAID_CONFIG.startOnLoad).toBe(false);
  });
});
