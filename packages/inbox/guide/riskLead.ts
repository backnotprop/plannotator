/**
 * The PR page's tree rows' risk bars (approval "review-risk-bars"): review-editor's `RISK_BARS_PARTS` before each named
 * file's icon. In the reader's chunk, beside the trees that draw it.
 */
import { useMemo } from 'react';
import { RISK_BARS_PARTS } from '@plannotator/review-editor/components/treeRows';
import type { PullTreeRisk } from './pullRepoTypes';

type RowPart = (typeof RISK_BARS_PARTS)['high'];

/** The tree's `fileLead` for these files, or undefined (no lead at all) with no risk to show. */
export function useRiskLead(risk: PullTreeRisk | null | undefined): ((path: string) => RowPart | null) | undefined {
  return useMemo(() => {
    if (!risk || risk.files.size === 0) return undefined;
    const part = RISK_BARS_PARTS[risk.level];
    return (path: string) => (risk.files.has(path) ? part : null);
  }, [risk]);
}
