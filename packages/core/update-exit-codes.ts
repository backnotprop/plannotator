/**
 * install.sh stopped because the binary did not match the checksum Plannotator fetched, before it
 * replaced anything.
 */
export const UPDATE_EXIT_CHECKSUM_MISMATCH = 113;

/** Plannotator could not download the install script or the checksum: nothing ran (sysexits EX_TEMPFAIL). */
export const UPDATE_EXIT_DOWNLOAD_FAILED = 75;

/** Run from a terminal to stage the update in another temp folder. */
export const UPDATE_OTHER_TMPDIR_COMMAND = "TMPDIR=/another/folder plannotator update";

/**
 * What to do about a temp folder that could not hold the update, by its cause: a phrase the caller
 * ends with ", then …".
 */
export function updateStagingAdvice(reason: string): string {
  if (/ is full \(/.test(reason)) return "Free some space there";
  if (/ can't be written \(/.test(reason)) return "Make it writable";
  if (/ does not exist \(/.test(reason)) return "Create it";
  return "Check that folder";
}
