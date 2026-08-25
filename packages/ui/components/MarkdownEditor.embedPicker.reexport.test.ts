// This test guards the supported consumer surface. A regression would force a
// host to import package internals or @plannotator/core directly.
import { describe, expect, test } from 'bun:test';
import { planEmbedInsert as corePlanEmbedInsert } from '@plannotator/core/embed-insert';

import {
  embedPicker,
  embedSlashItem,
  planEmbedInsert,
  type EmbedKind,
  type EmbedPickerConfig,
  type EmbedTarget,
  type EmbedInsertPlan,
} from './MarkdownEditor';

describe('MarkdownEditor module: embed picker re-exports', () => {
  test('exposes the picker and core planner through the supported UI import', () => {
    const kind: EmbedKind = 'html';
    const target: EmbedTarget = { kind, path: 'report.html', title: 'Report' };
    const config: EmbedPickerConfig = {
      getTargets: () => [target],
      buildInsertLine: (entry) => `[${entry.title ?? entry.path}](${entry.path}#embed)`,
      uploadTarget: async (uploadKind) => (uploadKind === kind ? target : null),
      getNotice: () => null,
    };
    const plan: EmbedInsertPlan = planEmbedInsert('/embed report', 0, 13, '[Report](report)');

    expect(typeof embedPicker).toBe('function');
    expect(typeof embedSlashItem).toBe('function');
    expect(embedPicker(config)).toBeDefined();
    expect(plan.insert).toContain('[Report](report)');
    expect(planEmbedInsert).toBe(corePlanEmbedInsert);
  });
});
