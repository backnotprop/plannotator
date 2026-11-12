import { useEffect, useState } from 'react';

export function useLatchedTrue(value: boolean): boolean {
  const [latched, setLatched] = useState(value);
  useEffect(() => {
    if (value) setLatched(true);
  }, [value]);
  return latched || value;
}
