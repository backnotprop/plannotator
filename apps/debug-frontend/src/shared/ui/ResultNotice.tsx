import type { ReactNode } from "react";
import { errorMessage, type DaemonApiError } from "../../daemon/api/errors";

interface ResultNoticeProps {
  tone: "info" | "error" | "empty";
  title: string;
  children?: ReactNode;
  error?: DaemonApiError;
}

export function ResultNotice({ tone, title, children, error }: ResultNoticeProps) {
  return (
    <section className={`notice notice-${tone}`} role={tone === "error" ? "alert" : "status"}>
      <h2>{title}</h2>
      {error ? <p>{errorMessage(error)}</p> : children}
    </section>
  );
}
