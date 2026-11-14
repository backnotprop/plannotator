// Only the bench imports @pierre/trees, and only when PIERRE_TREES_DIR points at it.
declare module '@pierre/trees' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const FileTree: any;
}
