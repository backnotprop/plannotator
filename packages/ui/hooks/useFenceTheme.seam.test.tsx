/**
 * Seam test: host-chosen fence theme (`configurePlannotatorUI({ fenceTheme })`,
 * `setFenceThemeResolver` / `resetFenceThemeResolver`).
 *
 * Contract: with no resolver installed, fences resolve exactly as before (the
 * palette's SHIKI_THEME_MAP entry, else pierre-dark / pierre-light). A host
 * resolver's string wins; `undefined` (or a throw, or an empty string) falls
 * through to the default. Every fence consumer reads `useFenceTheme`, so the
 * hook is the observable surface.
 *
 * The hook half needs a DOM (DOM_TESTS=1 preloads happy-dom); the resolver
 * half runs everywhere.
 *
 * Function references are captured at module load so configure.test.ts's
 * mock.module() calls cannot swap them out from under this file.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as syntaxTheme from '../utils/syntaxTheme';
import { useFenceTheme } from './useFenceTheme';
import { configurePlannotatorUI } from '../configure';

const resolveFenceTheme = syntaxTheme.resolveFenceTheme;
const setFenceThemeResolver = syntaxTheme.setFenceThemeResolver;
const resetFenceThemeResolver = syntaxTheme.resetFenceThemeResolver;

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;

afterEach(() => {
  resetFenceThemeResolver();
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  if (hasDom) document.body.innerHTML = '';
});

function renderFenceTheme(): string {
  let seen = '';
  function Probe() {
    seen = useFenceTheme();
    return null;
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Probe />));
  return seen;
}

describe('fence theme seam', () => {
  test('without a resolver, resolution is the built-in map', () => {
    expect(resolveFenceTheme('github', 'light')).toBe('github-light');
    expect(resolveFenceTheme('dracula', 'light')).toBe('pierre-light');
  });

  test('configurePlannotatorUI({ fenceTheme }) overrides, undefined falls through', () => {
    configurePlannotatorUI({ fenceTheme: (_palette, mode) => (mode === 'dark' ? 'vitesse-black' : undefined) });
    expect(resolveFenceTheme('github', 'dark')).toBe('vitesse-black');
    expect(resolveFenceTheme('github', 'light')).toBe('github-light');
  });

  test.skipIf(!hasDom)('the override reaches useFenceTheme, which every fence consumer reads', () => {
    // Outside a ThemeProvider the default context is the plannotator palette, dark.
    expect(renderFenceTheme()).toBe('pierre-dark');
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    const calls: Array<[string, string]> = [];
    configurePlannotatorUI({
      fenceTheme: (colorTheme, mode) => {
        calls.push([colorTheme, mode]);
        return mode === 'dark' ? 'vitesse-black' : undefined;
      },
    });
    expect(renderFenceTheme()).toBe('vitesse-black');
    expect(calls).toContainEqual(['plannotator', 'dark']);
  });

  test('a throwing or empty answer falls back to the default', () => {
    setFenceThemeResolver(() => {
      throw new Error('host bug');
    });
    expect(resolveFenceTheme('github', 'dark')).toBe('github-dark');
    setFenceThemeResolver(() => '');
    expect(resolveFenceTheme('github', 'dark')).toBe('github-dark');
  });

  test('resetting removes the override', () => {
    setFenceThemeResolver(() => 'nord');
    expect(resolveFenceTheme('github', 'light')).toBe('nord');
    resetFenceThemeResolver();
    expect(resolveFenceTheme('github', 'light')).toBe('github-light');
  });
});
