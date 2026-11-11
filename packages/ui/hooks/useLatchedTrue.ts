import { useEffect, useState } from 'react';

/** True from the first render where `value` is true, for the life of the component. */
export function useLatchedTrue(value: boolean): boolean {
  const [latched, setLatched] = useState(value);
  useEffect(() => {
    if (value) setLatched(true);
  }, [value]);
  return latched || value;
}
