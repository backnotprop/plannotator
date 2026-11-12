export const UPDATE_EXIT_CHECKSUM_MISMATCH = 113;

export const UPDATE_EXIT_DOWNLOAD_FAILED = 75;

export const UPDATE_OTHER_TMPDIR_COMMAND = "TMPDIR=/another/folder plannotator update";

export function updateStagingAdvice(reason: string): string {
  if (/ is full \(/.test(reason)) return "Free some space there";
  if (/ can't be written \(/.test(reason)) return "Make it writable";
  if (/ does not exist \(/.test(reason)) return "Create it";
  return "Check that folder";
}
