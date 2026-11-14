// The learned check: logistic regression over the evidence the rules already compute
// (src/inline.ts `evidence`). When enabled (`learned: true`, or SEMANTIC_LEARNED=1) it accepts a
// candidate the strict rules rejected only when it is very sure, and only if the rules' guards
// still pass. Off by default: on held-out sets it added no finds (and a few borderline claims). Weights are fitted on the practice labels only (never the held-out sets) by
// harness/classifier/train.py, tested by leaving one project out at a time: at the threshold
// below it added real finds and no wrong claims on projects it had not seen.
// Regenerate with: node harness/classifier/collect.ts ... && python3 harness/classifier/train.py ...

export interface Evidence {
  helperTokens: number;
  freshTokens: number;
  statements: number;
  movedStatements: number;
  strictPairs: number;
  strictShare: number;
  strictMeanSim: number;
  loosePairs: number;
  looseShare: number;
  bagDice: number;
  nameOverlap: number;
  hasValue: boolean;
  valueTokens: number;
  valueInFresh: boolean;
  calls: number;
  oneLine: boolean;
  sizeRatio: number;
  extract: boolean;
}

/** Trained on 2497 labelled practice candidates. */
const WEIGHTS = [0.586754, 0.159521, -0.821424, -0.123089, -0.0664206, 0.394717, 0.333287, 0.395416, 0.0742788, 0.234799, 0.541936, 1.62382, -0.111766, 0.369967, 0.220235, -0.0340056, 0.103244, -0.0111614, 0.321449];
const MEAN = [0, 4.06016, 5.15742, 1.20636, 0.8487, 0.353072, 0.194875, 0.275466, 0.463732, 0.242795, 0.410743, 0.621634, 0.787345, 2.19216, 0.18302, 0.833884, 0.221466, 0.545169, 0.809772];
const SCALE = [1, 1.01747, 1.65572, 0.555586, 0.770106, 0.617633, 0.334477, 0.426533, 0.63914, 0.337316, 0.322124, 0.319834, 0.409186, 1.67004, 0.386683, 0.312158, 0.415233, 0.651023, 0.392481];

/** Accept at or above this probability: in the leave-one-project-out test it added 19 real finds, no wrong or borderline claims. */
export const LEARNED_THRESHOLD = 0.96;

/** The same features, in the same order, as harness/classifier/train.py `feats`. */
function features(e: Evidence): number[] {
  const L = Math.log1p;
  return [
    1, L(e.helperTokens), L(e.freshTokens), L(e.statements), L(e.movedStatements),
    L(e.strictPairs), e.strictShare, e.strictMeanSim, L(e.loosePairs), e.looseShare,
    e.bagDice, e.nameOverlap, +e.hasValue, L(e.valueTokens), +e.valueInFresh,
    L(e.calls), +e.oneLine, Math.min(e.sizeRatio, 5), +e.extract,
  ];
}

/** How likely the helper's code really moved out of (or into) the caller. */
export function probabilityMoved(e: Evidence): number {
  const x = features(e);
  let z = 0;
  for (let i = 0; i < x.length; i++) z += WEIGHTS[i]! * (x[i]! - MEAN[i]!) / SCALE[i]!;
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

export const likelyMoved = (e: Evidence) => probabilityMoved(e) >= LEARNED_THRESHOLD;
