import { createContext, useContext } from 'react';

interface JobLogsState {
  jobLogs: Map<string, string>;
}

const JobLogsContext = createContext<JobLogsState>({ jobLogs: new Map() });

export const JobLogsProvider = JobLogsContext.Provider;

export function useJobLogs(): JobLogsState {
  return useContext(JobLogsContext);
}
