import { describe, expect, test } from 'bun:test';
import { goalSetupMaxWidth } from './goalSetupWidth';
import { getPlanMaxWidth } from '@plannotator/ui/utils/uiPreferences';

describe('goal setup width', () => {
  test('Wide keeps the 1280px cap on the goal setup form while the document fills', () => {
    expect(getPlanMaxWidth('wide')).toBeNull();
    expect(goalSetupMaxWidth('wide')).toBe(1280);
  });

  test('Compact and Default apply to the form as before', () => {
    expect(goalSetupMaxWidth('compact')).toBe(832);
    expect(goalSetupMaxWidth('default')).toBe(1040);
  });
});
