/**
 * Feature detection: the only gate between a browser without WebMCP and
 * the whole provider. It must return null for every absent or hostile shape
 * and never throw.
 */
import { describe, expect, test } from 'bun:test';
import { resolveModelContext } from './modelContext';

describe('resolveModelContext', () => {
  test('null when there is no document', () => {
    expect(resolveModelContext(null)).toBeNull();
  });

  test('null when the property is absent, not an object, or lacks registerTool', () => {
    expect(resolveModelContext({} as Document)).toBeNull();
    expect(resolveModelContext({ modelContext: 'yes' } as unknown as Document)).toBeNull();
    expect(resolveModelContext({ modelContext: {} } as unknown as Document)).toBeNull();
  });

  test('null, not a throw, when the property access itself throws (restricted contexts)', () => {
    const hostile = {};
    Object.defineProperty(hostile, 'modelContext', { get() { throw new Error('denied'); } });
    expect(resolveModelContext(hostile as Document)).toBeNull();
  });

  test('returns the context when registerTool is callable', () => {
    const ctx = { registerTool: async () => undefined };
    expect(resolveModelContext({ modelContext: ctx } as unknown as Document)).toBe(ctx);
  });
});
