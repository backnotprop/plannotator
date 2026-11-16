/**
 * A continuous piecewise-linear function of one container size, for sizes
 * from 0 up. The layout's `min()`, `max()`, and `clamp()` of linear values
 * give such a function, so each box edge can be written as one short CSS
 * value of the container size, with no custom properties.
 */
export interface Piecewise {
  /** Knot positions in ascending order. The first knot is 0. */
  readonly xs: readonly number[];
  /** The value at each knot. */
  readonly ys: readonly number[];
  /** The slope after the last knot. */
  readonly slope: number;
}

// Knots closer than this, and slope changes smaller than this, are the same.
const EPSILON = 1e-9;

export function constant(value: number): Piecewise {
  return { xs: [0], ys: [value], slope: 0 };
}

/** The container size itself. */
export function size(): Piecewise {
  return { xs: [0], ys: [0], slope: 1 };
}

export function evaluate(f: Piecewise, x: number): number {
  const { xs, ys } = f;
  const last = xs.length - 1;
  if (x >= xs[last]) return ys[last] + f.slope * (x - xs[last]);
  let index = 0;
  while (xs[index + 1] <= x) index++;
  const t = (x - xs[index]) / (xs[index + 1] - xs[index]);
  return ys[index] + t * (ys[index + 1] - ys[index]);
}

/** The slope of `f` on each segment: between knots, then after the last. */
function slopes(f: Piecewise): number[] {
  const result: number[] = [];
  for (let index = 0; index < f.xs.length - 1; index++)
    result.push(
      (f.ys[index + 1] - f.ys[index]) / (f.xs[index + 1] - f.xs[index])
    );
  result.push(f.slope);
  return result;
}

/**
 * The knots of two functions, in ascending order, without knots closer than
 * EPSILON to the knot before them. A merge of the two sorted lists, because
 * the compiler calls this for each operation on each box edge.
 */
function union(a: readonly number[], b: readonly number[]): number[] {
  const result: number[] = [];
  let previous = 0;
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const x = j >= b.length || (i < a.length && a[i] <= b[j]) ? a[i++] : b[j++];
    if (i + j === 1 || x - previous > EPSILON) result.push(x);
    previous = x;
  }
  return result;
}

/** Drop knots where the slope does not change. */
function simplify(xs: number[], ys: number[], slope: number): Piecewise {
  const keptX = [xs[0]];
  const keptY = [ys[0]];
  for (let index = 1; index < xs.length; index++) {
    const before =
      (ys[index] - keptY[keptY.length - 1]) /
      (xs[index] - keptX[keptX.length - 1]);
    const after =
      index + 1 < xs.length
        ? (ys[index + 1] - ys[index]) / (xs[index + 1] - xs[index])
        : slope;
    if (Math.abs(after - before) > EPSILON) {
      keptX.push(xs[index]);
      keptY.push(ys[index]);
    }
  }
  return { xs: keptX, ys: keptY, slope };
}

// A constant has one knot at 0, which every function has, so a sum with a
// constant keeps the knots of the other function, and its values at them.
const isConstant = (f: Piecewise): boolean =>
  f.xs.length === 1 && f.slope === 0;

export function add(f: Piecewise, g: Piecewise): Piecewise {
  if (isConstant(g))
    return simplify(
      f.xs as number[],
      f.ys.map((y) => y + g.ys[0]),
      f.slope
    );
  if (isConstant(f))
    return simplify(
      g.xs as number[],
      g.ys.map((y) => f.ys[0] + y),
      g.slope
    );
  const xs = union(f.xs, g.xs);
  return simplify(
    xs,
    xs.map((x) => evaluate(f, x) + evaluate(g, x)),
    f.slope + g.slope
  );
}

export function scale(f: Piecewise, factor: number): Piecewise {
  if (factor === 1) return f;
  return {
    xs: f.xs,
    ys: f.ys.map((y) => y * factor),
    slope: f.slope * factor,
  };
}

/** The lower (`sign` 1) or upper (`sign` -1) envelope of two functions. */
function envelope(f: Piecewise, g: Piecewise, sign: 1 | -1): Piecewise {
  const knots = union(f.xs, g.xs);
  // The values of both functions at each knot, read once.
  const fv = knots.map((x) => evaluate(f, x));
  const gv = knots.map((x) => evaluate(g, x));
  const pick = (a: number, b: number): number =>
    sign === 1 ? Math.min(a, b) : Math.max(a, b);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let index = 0; index < knots.length; index++) {
    const x = knots[index];
    xs.push(x);
    ys.push(pick(fv[index], gv[index]));
    const d = sign * (fv[index] - gv[index]);
    // A crossing between two knots, or after the last knot.
    let crossing: number | null = null;
    if (index + 1 < knots.length) {
      const e = sign * (fv[index + 1] - gv[index + 1]);
      if ((d > EPSILON && e < -EPSILON) || (d < -EPSILON && e > EPSILON))
        crossing = x + ((knots[index + 1] - x) * d) / (d - e);
    } else {
      const rate = sign * (f.slope - g.slope);
      if ((d > EPSILON && rate < 0) || (d < -EPSILON && rate > 0))
        crossing = x - d / rate;
    }
    if (crossing !== null) {
      xs.push(crossing);
      ys.push(pick(evaluate(f, crossing), evaluate(g, crossing)));
    }
  }
  // After the last knot, the lower (or upper) function stays below (above).
  const end = xs[xs.length - 1] + 1;
  const slope =
    sign * (evaluate(f, end) - evaluate(g, end)) <= 0 ? f.slope : g.slope;
  return simplify(xs, ys, slope);
}

export function min(f: Piecewise, g: Piecewise): Piecewise {
  return envelope(f, g, 1);
}

export function max(f: Piecewise, g: Piecewise): Piecewise {
  return envelope(f, g, -1);
}

/**
 * A function from its values at knots in ascending order, the first at 0, and
 * its slope after the last knot.
 */
export function fromPoints(
  xs: readonly number[],
  ys: readonly number[],
  slope: number
): Piecewise {
  return simplify([...xs], [...ys], slope);
}

/**
 * `outer(inner(x))`. Between the knots of `inner`, the result is linear until
 * `inner` crosses a knot of `outer`, so the knots of the result are the knots
 * of `inner` and those crossings.
 */
export function compose(outer: Piecewise, inner: Piecewise): Piecewise {
  const xs: number[] = [];
  const last = inner.xs.length - 1;
  for (let index = 0; index <= last; index++) {
    const x0 = inner.xs[index];
    const y0 = inner.ys[index];
    xs.push(x0);
    if (index < last) {
      const x1 = inner.xs[index + 1];
      const y1 = inner.ys[index + 1];
      for (const knot of outer.xs)
        if ((knot - y0) * (knot - y1) < 0)
          xs.push(x0 + ((knot - y0) * (x1 - x0)) / (y1 - y0));
    } else if (inner.slope !== 0) {
      for (const knot of outer.xs) {
        const x = x0 + (knot - y0) / inner.slope;
        if (x > x0) xs.push(x);
      }
    }
  }
  // The crossings of a falling segment come in descending order, so sort the
  // knots: `union` may expect each list in ascending order.
  const knots = union(
    [...xs].sort((x, y) => x - y),
    []
  );
  // After the last knot, `inner` is linear, and `outer` is on its last
  // segment when `inner` grows, or on its first when `inner` falls.
  const outerSlope =
    inner.slope > 0
      ? outer.slope
      : inner.slope < 0
        ? (slopes(outer)[0] ?? outer.slope)
        : 0;
  return simplify(
    knots,
    knots.map((x) => evaluate(outer, evaluate(inner, x))),
    outerSlope * inner.slope
  );
}

/** CSS `clamp(lower, value, upper)`: the upper bound wins over the lower. */
export function clamp(
  lower: Piecewise,
  value: Piecewise,
  upper: Piecewise
): Piecewise {
  return max(lower, min(value, upper));
}

// Eight significant digits keep a box within 0.0001 px on a 10,000 px container.
const format = (value: number): string =>
  Number.isInteger(value) && Math.abs(value) < 1e8
    ? String(value)
    : String(Number(value.toPrecision(8)));

/**
 * Write `f` as one CSS value of the container size `unit` (`100cqw`):
 * `f(0) + s0 × size + Σ (sᵢ − sᵢ₋₁) × max(0px, size − xᵢ)`, where sᵢ is the
 * slope after knot xᵢ. Each knot adds one hinge term, which is 0 below it.
 */
export function toCSS(f: Piecewise, unit: string): string {
  // Sibling boxes share the edges that their split does not divide, so the
  // compiler writes the same function more than once.
  let cache = cssCache.get(unit);
  if (cache === undefined) {
    cache = new WeakMap();
    cssCache.set(unit, cache);
  }
  let css = cache.get(f);
  if (css === undefined) {
    css = writeCSS(f, unit);
    cache.set(f, css);
  }
  return css;
}

// The CSS value of each function object, for each unit.
const cssCache = new Map<string, WeakMap<Piecewise, string>>();

function writeCSS(f: Piecewise, unit: string): string {
  const rates = slopes(f);
  const terms: string[] = [];
  if (Math.abs(rates[0]) > EPSILON)
    terms.push(rates[0] === 1 ? unit : `${format(rates[0])} * ${unit}`);
  for (let index = 1; index < f.xs.length; index++) {
    const change = rates[index] - rates[index - 1];
    if (Math.abs(change) <= EPSILON) continue;
    const hinge = `max(0px, ${unit} - ${format(f.xs[index])}px)`;
    terms.push(change === 1 ? hinge : `${format(change)} * ${hinge}`);
  }
  if (Math.abs(f.ys[0]) > EPSILON || terms.length === 0)
    terms.unshift(`${format(f.ys[0])}px`);
  if (terms.length === 1 && !terms[0].includes(' ')) return terms[0];
  return `calc(${terms.join(' + ')})`;
}
