import {
  add,
  compose,
  constant,
  evaluate,
  fromPoints,
  max,
  min,
  type Piecewise,
  scale,
  size,
} from './piecewise';

/** How one child of a split takes space along the axis of the split. */
export interface ChildSpec {
  /**
   * A fixed length in pixels, for a child that keeps its size when the split
   * changes size. Undefined for a child that shares the space by `weight`.
   */
  readonly px?: number;
  /** The share of a child without `px`, as a positive weight. */
  readonly weight: number;
  readonly min: number;
  /** The maximum size, or `Infinity`. */
  readonly max: number;
}

/**
 * The size of each child of a split as a function of the space of the split,
 * A, without its separators. The rules, in order:
 *
 * 1. A child with `px` keeps that size, within its minimum and maximum. The
 *    other children share the rest by weight, each within its minimum and
 *    maximum ("water filling").
 * 2. When the space shrinks, the children that share it shrink to their
 *    minimum sizes first. Then the children with `px` shrink to theirs, each
 *    in proportion to its size.
 * 3. Below the sum of the minimum sizes, each child gets a part of the space
 *    in proportion to its minimum size.
 * 4. Above the sum of the maximum sizes of the children that share the
 *    space, they grow past their maximums by weight, so that the split has
 *    no empty space.
 *
 * When no child shares the space, the children with `px` share it by their
 * sizes, or in equal parts when every size is 0. Each result is a continuous
 * piecewise-linear function of A, so that the CSS compiler can write it for
 * every container size.
 */
export function divide(specs: readonly ChildSpec[]): Piecewise[] {
  const space = size();
  const fixed = specs.some(({ px }) => px !== undefined);
  const flexible = specs.some(({ px }) => px === undefined);
  if (!fixed || !flexible) {
    // One group: every child shares the space, by weight or by its size.
    const weights = specs.map((spec) =>
      spec.px === undefined ? spec.weight : clampPx(spec)
    );
    return waterFill(
      weights,
      specs.map((spec) => spec.min),
      specs.map((spec) => spec.max)
    );
  }
  const sum = (values: number[]): number =>
    values.reduce((total, value) => total + value, 0);
  const fixedSpecs = specs.filter(({ px }) => px !== undefined);
  const flexSpecs = specs.filter(({ px }) => px === undefined);
  const fixedSize = sum(fixedSpecs.map(clampPx));
  const fixedMin = sum(fixedSpecs.map((spec) => spec.min));
  const flexMin = sum(flexSpecs.map((spec) => spec.min));
  const allMin = fixedMin + flexMin;
  // The space of the fixed children: their sizes while the others fit above
  // their minimums, then what the minimums of the others leave, and below the
  // sum of all minimums, a part in proportion to their minimums (rule 3).
  const fixedSpace = min(
    constant(fixedSize),
    max(
      scale(space, allMin > 0 ? fixedMin / allMin : 0),
      add(space, constant(-flexMin))
    )
  );
  const flexSpace = add(space, scale(fixedSpace, -1));
  const fixedSizes = waterFill(
    fixedSpecs.map(clampPx),
    fixedSpecs.map((spec) => spec.min),
    fixedSpecs.map(() => Infinity)
  ).map((share) => compose(share, fixedSpace));
  const flexSizes = waterFill(
    flexSpecs.map((spec) => spec.weight),
    flexSpecs.map((spec) => spec.min),
    flexSpecs.map((spec) => spec.max)
  ).map((share) => compose(share, flexSpace));
  let nextFixed = 0;
  let nextFlex = 0;
  return specs.map(({ px }) =>
    px === undefined ? flexSizes[nextFlex++] : fixedSizes[nextFixed++]
  );
}

/** The pixel size of a child with `px`, within its minimum and maximum. */
const clampPx = (spec: ChildSpec): number =>
  Math.max(spec.min, Math.min(spec.max, spec.px ?? 0));

/**
 * Share a space T by weight, each child within its minimum and maximum: child
 * i gets clamp(mᵢ, sᵢ·λ, Mᵢ), where sᵢ is its share of the weights and λ makes
 * the sizes add up to T. Below the sum of the minimums, each child gets a part
 * in proportion to its minimum. Above the sum of the maximums, each child
 * grows by its share. The result is piecewise linear in T, with a knot where
 * a child reaches its minimum or its maximum.
 *
 * When every weight is 0, the children get equal shares. A collapsed child of
 * 0 px is a child with `px: 0`, so the children with `px` of a split can have
 * no weight at all; a share of 0 / 0 would make every size NaN.
 */
function waterFill(
  weights: readonly number[],
  mins: readonly number[],
  maxs: readonly number[]
): Piecewise[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const shares = weights.map((weight) =>
    total > 0 ? weight / total : 1 / weights.length
  );
  const upper = maxs.map((value, index) => Math.max(value, mins[index]));
  const minimum = mins.reduce((sum, value) => sum + value, 0);
  const sizesAt = (lambda: number): number[] =>
    shares.map((share, index) =>
      Math.max(mins[index], Math.min(upper[index], share * lambda))
    );
  const sumOf = (values: readonly number[]): number =>
    values.reduce((sum, value) => sum + value, 0);
  // Knots of T, and the size of each child at each knot.
  const knots: number[] = [0];
  const values: number[][] = [shares.map(() => 0)];
  if (minimum > 0) {
    knots.push(minimum);
    values.push([...mins]);
  }
  const lambdas = [
    ...mins.map((value, index) => value / shares[index]),
    ...upper.map((value, index) => value / shares[index]),
  ]
    .filter((lambda) => Number.isFinite(lambda))
    .sort((a, b) => a - b);
  for (const lambda of lambdas) {
    const sizes = sizesAt(lambda);
    const at = sumOf(sizes);
    if (at > knots[knots.length - 1] + 1e-9) {
      knots.push(at);
      values.push(sizes);
    }
  }
  // After the last knot: the children with no maximum grow by their shares;
  // when every child has a maximum, all grow past it by their shares.
  const open = shares.map((_, index) => upper[index] === Infinity);
  const openShare = sumOf(shares.filter((_, index) => open[index]));
  return shares.map((share, index) => {
    const slope = openShare > 0 ? (open[index] ? share / openShare : 0) : share;
    return fromPoints(
      knots,
      values.map((sizes) => sizes[index]),
      slope
    );
  });
}

/**
 * The pixel size of each child for a space in pixels, from `divide`. The
 * last child gets the rest, so that the sizes add up to the space.
 */
export function divideSpace(
  available: number,
  specs: readonly ChildSpec[]
): number[] {
  const sizes = divide(specs).map((share) => evaluate(share, available));
  sizes[sizes.length - 1] =
    available - sizes.slice(0, -1).reduce((sum, value) => sum + value, 0);
  return sizes;
}
