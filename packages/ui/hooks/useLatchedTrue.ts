import { useEffect, useState } from 'react';

/**
 * True from the first render where `value` is true, for the life of the
 * component. The Apps use it to remember that an announcement was shown on
 * this load, so the next one in the chain waits for a later load even after
 * the first is dismissed.
 */
export function useLatchedTrue(value: boolean): boolean {
  const [latched, setLatched] = useState(value);
  useEffect(() => {
    if (value) setLatched(true);
  }, [value]);
  return latched || value;
}
