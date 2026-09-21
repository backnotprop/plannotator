/**
 * Hook contract (DOM-gated, DOM_TESTS=1): a fake `document.modelContext`
 * is installed with save/restore of the property descriptor.
 *
 * Regressions guarded: mount registers and unmount aborts; a rebuild with
 * new handler identities (deps changed, descriptors unchanged) swaps the
 * handlers in place and never calls registerTool again; `active: false`
 * (what the Settings toggle drives) aborts every controller and `true`
 * re-registers; the policy seam's `enabled: false` and `namePrefix` are
 * honored; a document without the API mounts with no effect at all.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useToolset } from './useToolset';
import { defineTool, ok, type ToolSpec } from './toolset';
import { resetWebMcpPolicy, setWebMcpPolicy } from './policy';
import type { ModelContextLike, ModelContextToolDescriptor } from './modelContext';

const hasDom = typeof document !== 'undefined';

interface FakeContext extends ModelContextLike {
  tools: Map<string, ModelContextToolDescriptor>;
  registrations: number;
}

function fakeContext(): FakeContext {
  const tools = new Map<string, ModelContextToolDescriptor>();
  const ctx: FakeContext = {
    tools,
    registrations: 0,
    registerTool(tool, options) {
      ctx.registrations += 1;
      tools.set(tool.name, tool);
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          tools.delete(tool.name);
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      });
    },
  };
  return ctx;
}

const originalDescriptor = hasDom ? Object.getOwnPropertyDescriptor(document, 'modelContext') : undefined;

function installFake(ctx: FakeContext | null) {
  if (ctx) {
    Object.defineProperty(document, 'modelContext', { configurable: true, value: ctx });
  } else if (originalDescriptor) {
    Object.defineProperty(document, 'modelContext', originalDescriptor);
  } else {
    delete (document as unknown as Record<string, unknown>).modelContext;
  }
}

function Harness({ active, handler, onResult }: { active: boolean; handler: () => string; onResult: (r: { available: boolean; registered: boolean }) => void }) {
  const build = React.useCallback(() => [
    defineTool<Record<string, never>, string>({ name: 'echo', description: 'Echo.', execute: () => ok(handler()) }) as ToolSpec<never, unknown>,
  ], [handler]);
  const result = useToolset({ id: 'test', active, build, deps: [handler], hooks: { buildNudges: () => [] } });
  onResult(result);
  return null;
}

async function mount(el: React.ReactElement): Promise<{ root: Root; rerender: (next: React.ReactElement) => Promise<void>; unmount: () => Promise<void> }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  let root!: Root;
  await act(async () => {
    root = createRoot(host);
    root.render(el);
  });
  return {
    root,
    rerender: async (next) => { await act(async () => { root.render(next); }); },
    unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

afterEach(() => {
  resetWebMcpPolicy();
  if (hasDom) installFake(null);
});

describe.skipIf(!hasDom)('useToolset', () => {
  test('mount registers prefixed tools, unmount aborts them; new handler identity never re-registers', async () => {
    const ctx = fakeContext();
    installFake(ctx);
    let last = { available: false, registered: false };
    const view = await mount(<Harness active handler={() => 'one'} onResult={(r) => { last = r; }} />);
    expect(last).toEqual({ available: true, registered: true });
    expect([...ctx.tools.keys()]).toEqual(['plannotator.echo']);
    const before = ctx.registrations;

    await view.rerender(<Harness active handler={() => 'two'} onResult={(r) => { last = r; }} />);
    expect(ctx.registrations).toBe(before);
    const response = (await ctx.tools.get('plannotator.echo')!.execute({}, { signal: new AbortController().signal })) as { data: string };
    expect(response.data).toBe('two');

    await view.unmount();
    expect(ctx.tools.size).toBe(0);
  });

  test('active=false aborts the registrations and active=true brings them back', async () => {
    const ctx = fakeContext();
    installFake(ctx);
    let last = { available: false, registered: false };
    const handler = () => 'x';
    const view = await mount(<Harness active handler={handler} onResult={(r) => { last = r; }} />);
    expect(ctx.tools.size).toBe(1);
    await view.rerender(<Harness active={false} handler={handler} onResult={(r) => { last = r; }} />);
    expect(ctx.tools.size).toBe(0);
    expect(last.registered).toBe(false);
    expect(last.available).toBe(true);
    await view.rerender(<Harness active handler={handler} onResult={(r) => { last = r; }} />);
    expect([...ctx.tools.keys()]).toEqual(['plannotator.echo']);
    await view.unmount();
  });

  test('the policy seam disables registration and renames the prefix', async () => {
    const ctx = fakeContext();
    installFake(ctx);
    setWebMcpPolicy({ enabled: false });
    let last = { available: false, registered: false };
    const view = await mount(<Harness active handler={() => 'x'} onResult={(r) => { last = r; }} />);
    expect(ctx.registrations).toBe(0);
    expect(last).toEqual({ available: true, registered: false });
    await view.unmount();

    setWebMcpPolicy({ namePrefix: 'host.' });
    const view2 = await mount(<Harness active handler={() => 'x'} onResult={() => {}} />);
    expect([...ctx.tools.keys()]).toEqual(['host.echo']);
    await view2.unmount();
  });

  test('a document without modelContext mounts with no registration and reports unavailable', async () => {
    installFake(null);
    let last = { available: true, registered: true };
    let built = 0;
    function Probe() {
      const result = useToolset({ id: 'probe', build: () => { built += 1; return []; }, deps: [], hooks: { buildNudges: () => [] } });
      last = result;
      return null;
    }
    const view = await mount(<Probe />);
    expect(last).toEqual({ available: false, registered: false });
    expect(built).toBe(0);
    await view.unmount();
  });
});
