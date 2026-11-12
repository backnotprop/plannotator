export interface ArchivedPlan {
  filename: string;
  title: string;
  date: string;
  timestamp: string;
  status: "approved" | "denied" | "unknown";
  size: number;
}
