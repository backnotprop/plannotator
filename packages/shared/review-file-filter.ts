import picomatch from 'picomatch/posix';

export interface ReviewFileFilter {
  include: string;
  exclude: string;
}

export const EMPTY_REVIEW_FILE_FILTER: ReviewFileFilter = { include: '', exclude: '' };

/** Commas inside braces, character classes, or escapes are part of the glob. */
export function splitReviewGlobs(input: string): string[] {
  const globs: string[] = [];
  let start = 0;
  let braces = 0;
  let inClass = false;
  for (let index = 0; index <= input.length; index++) {
    const char = input[index];
    if (char === undefined || (char === ',' && !inClass && braces === 0)) {
      const glob = input.slice(start, index).trim();
      if (glob) globs.push(glob);
      start = index + 1;
    } else if (char === '\\' && index + 1 < input.length) {
      index++;
    } else if (inClass) {
      if (char === ']') inClass = false;
    } else if (char === '[') {
      inClass = true;
    } else if (char === '{') {
      braces++;
    } else if (char === '}' && braces > 0) {
      braces--;
    }
  }
  return globs;
}

export function compileReviewFileFilter({ include, exclude }: ReviewFileFilter): ((path: string) => boolean) | null {
  const includes = splitReviewGlobs(include);
  const excludes = splitReviewGlobs(exclude);
  if (includes.length === 0 && excludes.length === 0) return null;
  const options = { dot: true, nonegate: true, noextglob: true, regex: false, posix: true, windows: false };
  const inScope = includes.length ? picomatch(includes, options) : null;
  const ignored = excludes.length ? picomatch(excludes, options) : null;
  return (path) => (!inScope || inScope(path)) && (!ignored || !ignored(path));
}
