import { parse } from 'yaml';
import { COORDS, NAMED } from './keys.ts';
import type { LoadIssue } from './types.ts';

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

// Schema lines (request:, response:, a payload's lines:) are code, one per line: a lone brace is legitimate.
const isCodeLines = (path: string) => /(^|\.)lines$/.test(path);
const join = (path: string, k: string) => (path ? `${path}.${k}` : k);

// A YAML flow sequence splits `[f(a, b), g()]` at every comma; items that open a bracket and close it later are joined back.
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
    for (const [k, v] of Object.entries(node)) rejoin(v, join(path, k));
  }
}

function lint(file: string, node: unknown, path: string, errors: LoadIssue[], warnings: LoadIssue[], named = 0): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => {
      if (typeof v === 'string' && !isCodeLines(path) && unbalanced(v)) {
        warnings.push({
          file, field: `${path}[${i}]`,
          message: `"${v}" has an unbalanced bracket; a comma inside [ ] split it. Write this list as a block list (one "- item" per line).`,
        });
      }
      lint(file, v, `${path}[${i}]`, errors, warnings);
    });
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (!named && COORDS.has(k)) errors.push({ file, field: join(path, k), message: 'coordinates are not allowed; place parts by band, order and span' });
      lint(file, v, join(path, k), errors, warnings, named ? named - 1 : Object.hasOwn(NAMED, k) ? NAMED[k]! : 0);
    }
  }
}

export function readYaml(file: string, text: string, errors: LoadIssue[], warnings: LoadIssue[]): Record<string, unknown> | null {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    errors.push({ file, field: '', message: String((e as Error).message).split('\n')[0]! });
    return null;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    errors.push({ file, field: '', message: 'expected a map of keys at the top of the file' });
    return null;
  }
  rejoin(doc);
  lint(file, doc, '', errors, warnings);
  return doc as Record<string, unknown>;
}
