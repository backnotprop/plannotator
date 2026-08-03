export interface ArchivedPlan {
  filename: string;
  title: string;
  date: string;
  timestamp: string;  // ISO string from file mtime
  status: "approved" | "denied" | "unknown";
  size: number;
}
