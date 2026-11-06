// Reading one YAML file of a drawing: parse, join list items a comma split,
// and lint for coordinates and split brackets.
import { parse } from 'yaml';
import { COORDS, NAMED } from './keys.ts';

const depthOf = (t: string) => {
  let d = 0;
  for (const c of t) {
    if ('([{'.includes(c)) d++;
    else if (')]}'.includes(c)) d--;
  }
  return d;
};

const unbalanced = (t: string) => {
  let d = 0;
  for (const c of t) {
    if ('([{'.includes(c)) d++;
    else if (')]}'.includes(c)) d--;
    if (d < 0) return true;
  }
  return d !== 0;
};

/** Schema lines under request: and response: (and a payload's lines:) are code, one line each: a lone brace is right there. */
const isCodeLines = (path: string) => /\.lines$/.test(path);

/**
 * In a YAML flow sequence, [f(a, b), g()] splits at every comma, brackets or
 * not. A run of items that opens a bracket and closes it later is joined back
 * into one item ("f(a" + "b)" becomes "f(a, b)").
 */
function rejoin(node: unknown, path = ''): void {
  if (Array.isArray(node)) {
    if (!isCodeLines(path) && node.some((v) => typeof v === 'string' && depthOf(v) !== 0)) {
      const out: unknown[] = [];
      for (let i = 0; i < node.length; i++) {
        const v = node[i];
        if (typeof v === 'string' && depthOf(v) > 0) {
          let acc = v;
          let d = depthOf(v);
          let j = i + 1;
          while (d > 0 && j < node.length && typeof node[j] === 'string') {
            acc += ', ' + node[j];
            d += depthOf(node[j]);
            j++;
          }
          if (d === 0) {
            out.push(acc);
            i = j - 1;
            continue;
          }
        }
        out.push(v);
      }
      node.splice(0, node.length, ...out);
    }
    node.forEach((v, i) => rejoin(v, `${path}[${i}]`));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) rejoin(v, `${path}.${k}`);
  }
}

function lint(node: unknown, path: string, errors: string[], warnings: string[], named = 0): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => {
      if (typeof v === 'string' && !isCodeLines(path) && unbalanced(v)) {
        warnings.push(`${path}[${i}]: "${v}" has an unbalanced bracket; a comma inside [ ] split it. Write this list as a block list (one "- item" per line).`);
      }
      lint(v, `${path}[${i}]`, errors, warnings);
    });
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (!named && COORDS.has(k)) errors.push(`${path}.${k}: coordinates are not allowed; place parts by band, order and span`);
      lint(v, `${path}.${k}`, errors, warnings, named ? named - 1 : NAMED[k] || 0);
    }
  }
}

/** Parse one file. Returns the document (a map), or null after pushing an error. */
export function readYaml(where: string, text: string, errors: string[], warnings: string[]): Record<string, unknown> | null {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    errors.push(`${where}: ${String((e as Error).message).split('\n')[0]}`);
    return null;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    errors.push(`${where}: expected a map of keys at the top of the file`);
    return null;
  }
  rejoin(doc);
  lint(doc, where, errors, warnings);
  return doc as Record<string, unknown>;
}
