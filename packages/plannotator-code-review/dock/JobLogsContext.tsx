/**
 * Separate context for live agent job logs.
 *
 * Split from ReviewStateContext to prevent high-frequency live log updates
 * (every ~200ms) from re-rendering all dockview panels. Only the agent
 * detail panel subscribes to this context.
 *
 * Pattern: Dan Abramov's "split contexts by update frequency" optimization.
 */

import { createContext, useContext } from 'react';

interface JobLogsState {
  jobLogs: Map<string, string>;
}

const JobLogsContext = createContext<JobLogsState>({ jobLogs: new Map() });

export const JobLogsProvider = JobLogsContext.Provider;

export function useJobLogs(): JobLogsState {
  return useContext(JobLogsContext);
}
