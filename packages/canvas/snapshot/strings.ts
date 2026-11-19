/** Every word a snapshot shows or reads out. One place, so they can be reviewed and replaced. */
export const SNAPSHOT_STRINGS = {
  open: 'Open canvas',
  openNamed: (title: string) => `Open canvas: ${title}`,
  /** Shown in place of a name when a snapshot has none. */
  items: (count: number) => (count === 1 ? '1 item' : `${count} items`),
  name: 'Snapshot name',
  behind: 'Changed on the canvas',
  update: 'Update',
  detached: 'No longer on the canvas',
  noSnapshot: 'This snapshot was removed from the canvas',
  noCanvas: 'This canvas is not available here',
  back: 'Back to plan',
  updateSnapshot: 'Update snapshot',
  /** For a host's "update all" control. */
  updateAll: (count: number) => (count === 1 ? 'Update 1 snapshot' : `Update ${count} snapshots`),
} as const;
