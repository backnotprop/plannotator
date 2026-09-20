/**
 * useOriginFork gate test (#1519).
 *
 * Contract under test:
 *  - The toggle is available only when originFork is non-null AND the
 *    *effective* provider id (resolved selection, else the server default —
 *    never array/registry order) is in originFork.providerIds.
 *  - forkOrigin is derived from that gate, not held as independent state:
 *    switching to a non-forking provider clears it even without an explicit
 *    reset.
 *
 * Requires DOM — runs under bun test (preloaded via bunfig.toml).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { useOriginFork, type OriginForkCapability } from './useOriginFork';
import { hasDom, mountHook } from './hookTestHarness';
import type { AIProviderOption } from '../utils/aiProvider';

afterEach(() => {
  if (hasDom) document.body.innerHTML = '';
});

type HookResult = ReturnType<typeof useOriginFork>;

function Harness({
  resultRef,
  originFork,
  providers,
  providerId,
  defaultProviderId,
}: {
  resultRef: { current: HookResult | null };
  originFork: OriginForkCapability | null;
  providers: AIProviderOption[];
  providerId: string | null;
  defaultProviderId: string | null;
}) {
  resultRef.current = useOriginFork({ originFork, providers, providerId, defaultProviderId });
  return null;
}

const PROVIDERS: AIProviderOption[] = [
  { id: 'codex-sdk', name: 'codex-sdk' },
  { id: 'claude-agent-sdk', name: 'claude-agent-sdk' },
];

async function mount(props: {
  originFork: OriginForkCapability | null;
  providers: AIProviderOption[];
  providerId: string | null;
  defaultProviderId: string | null;
}) {
  const resultRef: { current: HookResult | null } = { current: null };
  return mountHook(resultRef, <Harness resultRef={resultRef} {...props} />);
}

describe('useOriginFork', () => {
  test.skipIf(!hasDom)('unavailable when there is no origin-fork capability', async () => {
    const { result } = await mount({
      originFork: null,
      providers: PROVIDERS,
      providerId: 'claude-agent-sdk',
      defaultProviderId: null,
    });
    expect(result.current!.toggleProps.available).toBe(false);
    expect(result.current!.forkOrigin).toBe(false);
  });

  test.skipIf(!hasDom)('available when the explicitly selected provider can fork the origin session', async () => {
    const { result } = await mount({
      originFork: { agent: 'claude-code', providerIds: ['claude-agent-sdk'] },
      providers: PROVIDERS,
      providerId: 'claude-agent-sdk',
      defaultProviderId: 'codex-sdk',
    });
    expect(result.current!.toggleProps.available).toBe(true);
    expect(result.current!.toggleProps.agentName).toBe('Claude Code');
  });

  test.skipIf(!hasDom)('unavailable when the selected provider cannot fork it', async () => {
    const { result } = await mount({
      originFork: { agent: 'claude-code', providerIds: ['claude-agent-sdk'] },
      providers: PROVIDERS,
      providerId: 'codex-sdk',
      defaultProviderId: 'codex-sdk',
    });
    expect(result.current!.toggleProps.available).toBe(false);
  });

  test.skipIf(!hasDom)('falls back to the server default, not provider array order, when the selection is unknown', async () => {
    // providerId names a provider not present in `providers` (e.g. a stale
    // saved preference) — must resolve via defaultProviderId, not PROVIDERS[0].
    const { result } = await mount({
      originFork: { agent: 'claude-code', providerIds: ['claude-agent-sdk'] },
      providers: PROVIDERS,
      providerId: 'unknown-provider',
      defaultProviderId: 'claude-agent-sdk',
    });
    expect(result.current!.toggleProps.available).toBe(true);
  });

  test.skipIf(!hasDom)('forkOrigin is derived: enabling then switching to a non-forking provider clears it without a reset', async () => {
    const { result, rerender, unmount } = await mount({
      originFork: { agent: 'claude-code', providerIds: ['claude-agent-sdk'] },
      providers: PROVIDERS,
      providerId: 'claude-agent-sdk',
      defaultProviderId: 'claude-agent-sdk',
    });

    await act(async () => {
      result.current!.toggleProps.onToggle(true);
    });
    expect(result.current!.forkOrigin).toBe(true);

    // Re-render with the provider switched away from a forking one — no call
    // into the hook's toggle handler, just a prop change (mirrors an app
    // switching `providerId` after a picker selection).
    await rerender(
      <Harness
        resultRef={result}
        originFork={{ agent: 'claude-code', providerIds: ['claude-agent-sdk'] }}
        providers={PROVIDERS}
        providerId="codex-sdk"
        defaultProviderId="claude-agent-sdk"
      />,
    );

    expect(result.current!.toggleProps.available).toBe(false);
    expect(result.current!.forkOrigin).toBe(false);

    await unmount();
  });
});
