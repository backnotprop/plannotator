/**
 * Security invariants pinned at source level (the `live-proxy` suites'
 * precedent): Plannotator's provider never runs inside a frame it does not
 * own, and neither annotate iframe ever delegates the `tools` permission.
 *
 *  - The srcdoc viewer keeps `sandbox="allow-scripts"` and no `allow`
 *    attribute, so the framed page has an opaque origin and the WebMCP
 *    `tools` policy (default allowlist 'self') denies it.
 *  - The live-app iframe (cross-origin by port) gets no `allow="tools"`
 *    either; phase 3 revisits that deliberately, never by accident.
 *  - The bridge script that runs inside the annotated page, and the proxy
 *    core that assembles it, contain no reference to the WebMCP entry point.
 *  - Nothing under components/html-viewer imports the engine.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const UI = join(import.meta.dir, '..');
const REPO = join(UI, '..', '..');
const read = (path: string) => readFileSync(path, 'utf8');

describe('iframe isolation', () => {
  test('the srcdoc iframe keeps sandbox="allow-scripts" and neither iframe delegates tools', () => {
    const source = read(join(UI, 'components/html-viewer/HtmlViewer.tsx'));
    const iframeStart = source.indexOf('<iframe');
    expect(iframeStart).toBeGreaterThan(0);
    const iframe = source.slice(iframeStart, source.indexOf('/>', iframeStart));
    expect(iframe).toContain('sandbox: "allow-scripts"');
    expect(iframe).not.toMatch(/\ballow\s*[:=]/);
    // Only one iframe element in the viewer: the srcdoc/src branches share it.
    expect(source.indexOf('<iframe', iframeStart + 1)).toBe(-1);
    expect(source).not.toMatch(/allow\s*[:=]\s*["'`][^"'`]*tools/);
  });

  test('the in-page bridge and the proxy core never spell the WebMCP entry point', () => {
    for (const file of [
      join(UI, 'components/html-viewer/bridge-script.ts'),
      join(REPO, 'packages/shared/live-proxy-core.ts'),
    ]) {
      expect(read(file)).not.toContain('modelContext');
    }
  });

  test('nothing under components/html-viewer imports the engine', () => {
    const dir = join(UI, 'components/html-viewer');
    for (const name of readdirSync(dir)) {
      if (!/\.(ts|tsx)$/.test(name)) continue;
      const source = read(join(dir, name));
      expect(source).not.toMatch(/from ['"][^'"]*webmcp/);
    }
  });

  test('document.modelContext is spelled in exactly one engine file', () => {
    const dir = join(UI, 'webmcp');
    const offenders = readdirSync(dir).filter((name) => {
      if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) return false;
      return read(join(dir, name)).includes("'modelContext'");
    });
    expect(offenders).toEqual(['modelContext.ts']);
  });
});
