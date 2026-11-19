/** Every word a snapshot shows or reads out. One place, so they can be reviewed and replaced. */
export const SNAPSHOT_STRINGS = {
  open: 'Open canvas',
  openNamed: (title: string) => `Open canvas: ${title}`,
  back: 'Back to plan',
  someDeleted: (missing: number, total: number) => `${missing} of ${total} items were deleted from the canvas`,
  allDeleted: 'Everything in this snapshot was deleted from the canvas',
  frameDeleted: 'The frame in this snapshot was deleted from the canvas',
  noSnapshot: 'This snapshot was removed from the canvas',
  noCanvas: 'This canvas is not available here',
} as const;
