/**
 * The engine's core (tree, store, geometry): the only way app code reaches the vendored copy. When @pierre/layouts is
 * on npm, this line becomes `export * from '@pierre/layouts'` and upstream/ goes (README.md, "Retire the mirror").
 */
export * from '../upstream/src/index';
