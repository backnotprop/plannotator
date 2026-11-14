// Stands in for @pierre/trees when PIERRE_TREES_DIR is not set (vite.config.ts).
export class FileTree {
  constructor() {
    throw new Error('Pierre is not installed: set PIERRE_TREES_DIR to an @pierre/trees package folder and build again.');
  }
}
