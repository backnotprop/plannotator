import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CompactEditControls } from './CompactEditControls';

describe('CompactEditControls', () => {
  test('keeps source-file Save and Cancel in a normal-flow touch row', () => {
    const html = renderToStaticMarkup(
      <CompactEditControls
        documentTitle="notes.md"
        sourceBacked
        saveStatus="dirty"
        cancelMode
        confirmDiscard={false}
        onSave={() => {}}
        onExit={() => {}}
      />,
    );

    expect(html).toContain('data-pn-compact-edit-controls="true"');
    expect(html).toContain('Editing notes.md');
    expect(html).toContain('>Save<');
    expect(html).toContain('>Cancel<');
    expect(html.match(/data-pn-touch-target/g)).toHaveLength(2);
    expect(html).not.toContain('fixed');
    expect(html).not.toContain('sticky');
  });

  test('uses Done for plan edits and a clear second-step discard label', () => {
    const plan = renderToStaticMarkup(
      <CompactEditControls
        documentTitle="Plan"
        sourceBacked={false}
        saveStatus={undefined}
        cancelMode={false}
        confirmDiscard={false}
        onSave={() => {}}
        onExit={() => {}}
      />,
    );
    const discard = renderToStaticMarkup(
      <CompactEditControls
        documentTitle="notes.md"
        sourceBacked
        saveStatus="dirty"
        cancelMode
        confirmDiscard
        onSave={() => {}}
        onExit={() => {}}
      />,
    );

    expect(plan).toContain('>Done<');
    expect(plan).not.toContain('>Save<');
    expect(discard).toContain('>Discard changes<');
  });
});
