import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApproveDropdown } from './ApproveDropdown';

describe('ApproveDropdown', () => {
  test('does not show agent-switch label when only extra approval entries are enabled', () => {
    const html = renderToStaticMarkup(
      <ApproveDropdown
        onApprove={() => {}}
        agents={[]}
        extraEntries={[{
          id: 'approve-bypass-clear-reminder',
          label: 'Approve + Bypass + /clear Reminder',
          onSelect: () => {},
        }]}
      />,
    );

    expect(html).toContain('Approve');
    expect(html).not.toContain('build');
    expect(html).not.toContain('(?)');
  });
});
