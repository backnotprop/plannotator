function unavailable(): never {
  throw new Error(
    '@pierre/patches is not bundled by Plannotator: diffs use jsdiff (preferredDiffLib: \'jsdiff\'). ' +
      'Remove the `@pierre/patches` alias in the app vite config to re-enable it.',
  );
}

export const createTwoFilesPatch = unavailable;
export const diffChars = unavailable;
export const diffWordsWithSpace = unavailable;
