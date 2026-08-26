/**
 * Engine contract, no DOM: a fake ModelContext is injected directly.
 *
 * Regressions guarded: a set attaches once and detaches by abort; a
 * StrictMode double attach ends with exactly one live registration; a
 * re-attach with unchanged descriptors swaps the handler without touching
 * registerTool; duplicate names across sets are skipped with a warning and
 * never replace the live tool; a throwing handler, an `undefined` result and
 * an unserializable result all reach the caller as an envelope with nudges
 * (never a rejection); schema problems answer `invalid_input` before the
 * handler runs; activity is recorded only for successful calls.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createToolRegistry, defineTool, fail, ok, runTool, type ToolsetHooks } from './toolset';
import type { ModelContextLike, ModelContextToolDescriptor } from './modelContext';
import { getWebMcpActivity, resetWebMcpActivity } from './activity';

interface FakeContext extends ModelContextLike {
  tools: Map<string, ModelContextToolDescriptor>;
  registrations: number;
  call(name: string, input?: unknown): Promise<unknown>;
}

function fakeContext(): FakeContext {
  const tools = new Map<string, ModelContextToolDescriptor>();
  const ctx: FakeContext = {
    tools,
    registrations: 0,
    registerTool(tool, options) {
      ctx.registrations += 1;
      if (tools.has(tool.name)) return Promise.reject(new DOMException('duplicate', 'InvalidStateError'));
      tools.set(tool.name, tool);
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          // Spec: abort steps unregister synchronously and reject the registration.
          tools.delete(tool.name);
          reject(options.signal!.reason ?? new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
    },
    async call(name, input) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`no tool ${name}`);
      return tool.execute(input, { signal: new AbortController().signal });
    },
  };
  return ctx;
}

const quietHooks: ToolsetHooks = { buildNudges: () => [] };

const echo = defineTool<{ value?: string }, { value: string }>({
  name: 'echo',
  description: 'Echo the value.',
  inputSchema: { type: 'object', properties: { value: { type: 'string', maxLength: 5 } } },
  execute: (input) => ok({ value: input.value ?? 'none' }),
});

afterEach(() => {
  resetWebMcpActivity();
});

describe('createToolRegistry', () => {
  test('attach registers prefixed names and detach aborts them out of the context', async () => {
    const ctx = fakeContext();
    const registry = createToolRegistry(ctx, { prefix: () => 'plannotator.' });
    const detach = registry.attach('doc', [echo], quietHooks);
    expect(registry.names()).toEqual(['plannotator.echo']);
    expect([...ctx.tools.keys()]).toEqual(['plannotator.echo']);
    detach();
    expect(registry.names()).toEqual([]);
    expect(ctx.tools.size).toBe(0);
  });

  test('StrictMode double attach ends with one live registration', () => {
    const ctx = fakeContext();
    const registry = createToolRegistry(ctx, { prefix: () => 'p.' });
    const first = registry.attach('doc', [echo], quietHooks);
    first();
    const second = registry.attach('doc', [echo], quietHooks);
    expect(ctx.tools.size).toBe(1);
    expect(registry.names()).toEqual(['p.echo']);
    second();
    expect(ctx.tools.size).toBe(0);
  });

  test('re-attaching an unchanged descriptor swaps the handler without calling registerTool again', async () => {
    const ctx = fakeContext();
    const registry = createToolRegistry(ctx, { prefix: () => 'p.' });
    registry.attach('doc', [echo], quietHooks);
    const before = ctx.registrations;
    const replacement = defineTool<{ value?: string }, { value: string }>({ ...echo, execute: () => ok({ value: 'swapped' }) });
    registry.attach('doc', [replacement], quietHooks);
    expect(ctx.registrations).toBe(before);
    const response = (await ctx.call('p.echo', {})) as { ok: boolean; data: { value: string } };
    expect(response.data.value).toBe('swapped');
  });

  test('a changed description re-registers under the same name', () => {
    const ctx = fakeContext();
    const registry = createToolRegistry(ctx, { prefix: () => 'p.' });
    registry.attach('doc', [echo], quietHooks);
    registry.attach('doc', [{ ...echo, description: 'Echo, but described differently.' }], quietHooks);
    expect(ctx.registrations).toBe(2);
    expect(ctx.tools.get('p.echo')?.description).toBe('Echo, but described differently.');
  });

  test('a name owned by another set is skipped with a warning and never replaced', () => {
    const ctx = fakeContext();
    const warnings: string[] = [];
    const registry = createToolRegistry(ctx, { prefix: () => 'p.', warn: (m) => warnings.push(m) });
    registry.attach('a', [echo], quietHooks);
    const detachB = registry.attach('b', [{ ...echo, execute: () => ok({ value: 'b' }) }], quietHooks);
    expect(warnings.length).toBe(1);
    expect(ctx.registrations).toBe(1);
    detachB();
    // Detaching the loser must not take the winner down.
    expect(registry.names()).toEqual(['p.echo']);
  });

  test('a tool dropped from the set on re-attach is aborted', () => {
    const ctx = fakeContext();
    const registry = createToolRegistry(ctx, { prefix: () => 'p.' });
    const other = defineTool<Record<string, never>, null>({ name: 'other', description: 'Other.', execute: () => ok(null) });
    registry.attach('doc', [echo, other], quietHooks);
    registry.attach('doc', [echo], quietHooks);
    expect(registry.names()).toEqual(['p.echo']);
    expect(ctx.tools.has('p.other')).toBe(false);
  });

  test('registration rejection is swallowed and logged, never thrown', async () => {
    const ctx = fakeContext();
    ctx.registerTool = () => Promise.reject(new DOMException('nope', 'NotAllowedError'));
    const warnings: string[] = [];
    const registry = createToolRegistry(ctx, { prefix: () => 'p.', warn: (m) => warnings.push(m) });
    expect(() => registry.attach('doc', [echo], quietHooks)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(warnings.some((w) => w.includes('p.echo'))).toBe(true);
  });
});

describe('runTool envelope', () => {
  const nudgeHooks: ToolsetHooks = {
    buildNudges: () => [{ code: 'pending_unsent', message: 'x' }],
  };

  test('a throwing handler becomes { ok: false, error.code: failed } with nudges attached', async () => {
    const boom = defineTool<Record<string, never>, null>({ name: 'boom', description: 'Throws.', execute: () => { throw new Error('kaboom'); } });
    const response = await runTool(boom as never, nudgeHooks, {}, { signal: new AbortController().signal });
    expect(response.ok).toBe(false);
    if (response.ok === false) {
      expect(response.error.code).toBe('failed');
      expect(response.error.message).toBe('kaboom');
    }
    expect(response.nudges.length).toBe(1);
  });

  test('a rejected promise from the handler is also data, never a rejection', async () => {
    const reject = defineTool<Record<string, never>, null>({ name: 'reject', description: 'Rejects.', execute: async () => { throw new Error('async kaboom'); } });
    const response = await runTool(reject as never, quietHooks, {}, { signal: new AbortController().signal });
    expect(response.ok).toBe(false);
  });

  test('undefined data is coerced to null so the browser can JSON-serialize it', async () => {
    const empty = defineTool<Record<string, never>, undefined>({ name: 'empty', description: 'Nothing.', execute: () => ok(undefined) });
    const response = await runTool(empty as never, quietHooks, {}, { signal: new AbortController().signal });
    expect(response).toEqual({ ok: true, data: null, nudges: [] });
  });

  test('a handler returning a non-result value is reported as failed', async () => {
    const raw = defineTool<Record<string, never>, unknown>({ name: 'raw', description: 'Raw.', execute: () => 42 as never });
    const response = await runTool(raw as never, quietHooks, {}, { signal: new AbortController().signal });
    expect(response.ok).toBe(false);
  });

  test('an unserializable result is reported as failed instead of surfacing as UnknownError', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cycle = defineTool<Record<string, never>, unknown>({ name: 'cycle', description: 'Cycle.', execute: () => ok(cyclic) });
    const response = await runTool(cycle as never, quietHooks, {}, { signal: new AbortController().signal });
    expect(response.ok).toBe(false);
    if (response.ok === false) expect(response.error.message).toContain('unserializable');
  });

  test('schema violations answer invalid_input before the handler runs', async () => {
    let ran = false;
    const strict = defineTool<{ value?: string }, null>({
      ...echo,
      name: 'strict',
      execute: () => { ran = true; return ok(null); },
    });
    const response = await runTool(strict as never, quietHooks, { value: 'toolong' }, { signal: new AbortController().signal });
    expect(response.ok).toBe(false);
    if (response.ok === false) expect(response.error.code).toBe('invalid_input');
    expect(ran).toBe(false);
  });

  test('a missing input object is treated as the empty call', async () => {
    const response = await runTool(echo as never, quietHooks, undefined, { signal: new AbortController().signal });
    expect(response).toEqual({ ok: true, data: { value: 'none' }, nudges: [] });
  });

  test('cursor rides on the envelope and afterResponse sees the final response', async () => {
    const seen: unknown[] = [];
    const cursored = defineTool<Record<string, never>, string>({ name: 'cursored', description: 'Cursor.', execute: () => ok('x', 'w:3') });
    const response = await runTool(cursored as never, { buildNudges: () => [], afterResponse: (r) => seen.push(r) }, {}, { signal: new AbortController().signal });
    expect(response.ok && response.cursor).toBe('w:3');
    expect(seen).toEqual([response]);
  });

  test('nudge builder failures degrade to an empty list instead of failing the call', async () => {
    const response = await runTool(echo as never, { buildNudges: () => { throw new Error('nudge boom'); } }, {}, { signal: new AbortController().signal });
    expect(response.ok).toBe(true);
    expect(response.nudges).toEqual([]);
  });

  test('activity is recorded only for successful calls', async () => {
    expect(getWebMcpActivity().calls).toBe(0);
    const boom = defineTool<Record<string, never>, null>({ name: 'boom', description: 'Throws.', execute: () => { throw new Error('x'); } });
    await runTool(boom as never, quietHooks, {}, { signal: new AbortController().signal });
    expect(getWebMcpActivity().calls).toBe(0);
    await runTool(echo as never, quietHooks, {}, { signal: new AbortController().signal });
    expect(getWebMcpActivity()).toEqual({ calls: 1, lastTool: 'echo' });
  });

  test('fail() carries hint and candidates through to the caller', async () => {
    const ambiguous = defineTool<Record<string, never>, null>({
      name: 'amb',
      description: 'Ambiguous.',
      execute: () => fail('ambiguous', 'two matches', { hint: 'add section', candidates: ['a', 'b'] }),
    });
    const response = await runTool(ambiguous as never, quietHooks, {}, { signal: new AbortController().signal });
    expect(response.ok).toBe(false);
    if (response.ok === false) expect(response.error).toEqual({ code: 'ambiguous', message: 'two matches', hint: 'add section', candidates: ['a', 'b'] });
  });
});

describe('defineTool', () => {
  test('rejects names outside the spec pattern at definition time', () => {
    expect(() => defineTool({ name: 'has space', description: 'x', execute: () => ok(null) })).toThrow();
    expect(() => defineTool({ name: 'ok_name.v1-x', description: 'x', execute: () => ok(null) })).not.toThrow();
    expect(() => defineTool({ name: 'nodesc', description: '  ', execute: () => ok(null) })).toThrow();
  });
});
