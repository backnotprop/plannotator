import { useMemo } from 'react';
import { useListLook } from '../listLook';
import { boardProjectNames } from './model';

/** The Board's project names (`boardProjectNames`), with Settings → Rows' "Machine names on projects" applied. */
export function useBoardProjectNames(projects: Parameters<typeof boardProjectNames>[0], machineNames: ReadonlyMap<string, string>): Map<string, string> {
  const [look] = useListLook();
  return useMemo(() => boardProjectNames(projects, machineNames, look.hideMachineNames), [projects, machineNames, look.hideMachineNames]);
}
