/**
 * MessagesBrowser — Sidebar list of recent assistant messages.
 *
 * Used by annotate-last. Lets the user pick which assistant message to
 * annotate when the newest transcript entry isn't the one they intended
 * (e.g., after `/rewind`).
 */

import React from "react";

export interface PickerMessage {
  messageId: string;
  text: string;
  timestamp?: string;
}

interface MessagesBrowserProps {
  messages: PickerMessage[];
  selectedMessageId: string | null;
  onSelect: (messageId: string) => void;
  annotationCounts?: Map<string, number>;
}

// Hard cap for browsers where line-clamp is unavailable, and to avoid huge sidebar text nodes.
const PREVIEW_MAX_CHARS = 140;

function previewText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > PREVIEW_MAX_CHARS
    ? normalized.slice(0, PREVIEW_MAX_CHARS).trimEnd() + "…"
    : normalized;
}

function formatTimestamp(ts?: string): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString([], {
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  });
}

export const MessagesBrowser: React.FC<MessagesBrowserProps> = ({
  messages,
  selectedMessageId,
  onSelect,
  annotationCounts,
}) => {
  if (messages.length === 0) {
    return (
      <div className="p-4 text-xs text-muted-foreground text-center">
        No recent assistant messages found.
      </div>
    );
  }

  return (
    <div className="p-2">
      <div className="px-2 pt-1 pb-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
        Recent messages — newest first
      </div>
      <div className="space-y-0.5">
        {messages.map((msg, idx) => {
          const isSelected = msg.messageId === selectedMessageId;
          const isDefault = idx === 0;
          const ts = formatTimestamp(msg.timestamp);
          const annotationCount = annotationCounts?.get(msg.messageId) ?? 0;
          return (
            <button
              key={msg.messageId}
              onClick={() => onSelect(msg.messageId)}
              className={`w-full text-left px-2 py-1.5 rounded text-xs transition-colors flex items-start gap-2 ${
                isSelected
                  ? "bg-primary/10 text-primary border border-primary/30"
                  : "text-foreground hover:bg-muted/50 border border-transparent"
              }`}
            >
              <span className="font-mono text-[10px] text-muted-foreground pt-0.5 w-8 shrink-0 text-right">
                #{idx + 1}
                {isDefault ? " ★" : ""}
              </span>
              <span className="flex-1 min-w-0">
                <span className="line-clamp-2 leading-snug">
                  {previewText(msg.text)}
                </span>
                {ts && (
                  <span className="block text-[10px] text-muted-foreground mt-0.5">
                    {ts}
                  </span>
                )}
              </span>
              {annotationCount > 0 && (
                <span
                  className="shrink-0 min-w-5 h-5 px-1 rounded-full bg-primary/10 text-primary border border-primary/30 text-[10px] font-semibold inline-flex items-center justify-center"
                  title={`${annotationCount} annotation${annotationCount === 1 ? "" : "s"}`}
                >
                  {annotationCount}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};
