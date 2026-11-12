export interface TourDiffAnchor {
  file: string;
  line: number;
  end_line: number;
  hunk: string;
  label: string;
}

export interface TourKeyTakeaway {
  text: string;
  severity: "info" | "important" | "warning";
}

export interface TourStop {
  title: string;
  gist: string;
  detail: string;
  transition: string;
  anchors: TourDiffAnchor[];
}

export interface TourQAItem {
  question: string;
  stop_indices: number[];
}

export interface CodeTourOutput {
  title: string;
  greeting: string;
  intent: string;
  before: string;
  after: string;
  key_takeaways: TourKeyTakeaway[];
  stops: TourStop[];
  qa_checklist: TourQAItem[];
}

export type CodeTourData = CodeTourOutput & { checklist: boolean[] };
