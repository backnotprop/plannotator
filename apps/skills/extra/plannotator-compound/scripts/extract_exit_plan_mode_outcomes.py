#!/usr/bin/env python3
"""Extract ExitPlanMode outcomes from Claude Code JSONL session logs.

This parser keeps three views of the same data:

1. Strict native Claude Code classification
   - native approval:
     "User has approved your plan."
   - native denial:
     "The user doesn't want to proceed with this tool use. The tool use was rejected"

2. General denial capture
   - any matching ExitPlanMode tool_result with is_error=true and non-empty text
     is captured as a denial/error payload, even when it is custom hook output
     or some other non-native integration.

3. Human-reason extraction
   - native inline reasons are preserved as-is
   - freeform non-native error payloads are treated as human reasons
   - structured non-native payloads are reduced to quoted feedback where possible

This means the script does not depend on hook-specific strings to capture custom
denials, but it also does not dump wrapper boilerplate into the human-reason
output.

The script streams JSONL line-by-line and uses only the Python standard library.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Optional, Tuple


APPROVE_PREFIX = "User has approved your plan."
REJECT_PREFIX = (
    "The user doesn't want to proceed with this tool use. "
    "The tool use was rejected"
)
REASON_MARKER = "To tell you how to proceed, the user said:\n"
NOTE_MARKER = (
    "\n\nNote: The user's next message may contain a correction or preference."
)


@dataclass
class AttemptRecord:
    session_id: str
    tool_use_id: str
    file_path: str
    line_number: int
    timestamp: Optional[str]
    cwd: Optional[str]
    plan_file_path: Optional[str]
    plan_length_chars: Optional[int]
    outcome: str = "pending"
    native_reason: Optional[str] = None
    native_reason_style: Optional[str] = None
    captured_reason: Optional[str] = None
    captured_reason_style: Optional[str] = None
    captured_reason_source: Optional[str] = None
    human_reason: Optional[str] = None
    human_reason_style: Optional[str] = None
    human_reason_source: Optional[str] = None
    result_is_error: Optional[bool] = None
    result_file_path: Optional[str] = None
    result_line_number: Optional[int] = None
    result_timestamp: Optional[str] = None
    result_preview: Optional[str] = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract ExitPlanMode approvals/denials from Claude Code logs."
    )
    parser.add_argument(
        "--projects-dir",
        default="~/.claude/projects",
        help="Root Claude projects directory. Default: %(default)s",
    )
    parser.add_argument(
        "--include-subagents",
        action="store_true",
        help="Include /subagents/ JSONL files. Default is to skip them.",
    )
    parser.add_argument(
        "--records-filter",
        choices=("all", "native", "native-denials", "denials", "human-reasons"),
        default="human-reasons",
        help=(
            "Which records to write to JSON/CSV outputs. "
            "Default: %(default)s"
        ),
    )
    parser.add_argument(
        "--include-non-native-denials",
        action="store_true",
        help=(
            "Include non-native denial/error payloads in sample output. "
            "Default sample output shows only native denials."
        ),
    )
    parser.add_argument(
        "--show-samples",
        type=int,
        default=5,
        help="How many denial samples to print in the text summary.",
    )
    parser.add_argument(
        "--json-out",
        help="Optional path to write a JSON report.",
    )
    parser.add_argument(
        "--max-output-tokens-per-file",
        type=int,
        default=50000,
        help=(
            "Approximate max token budget per JSON file when writing --json-out. "
            "Default: %(default)s"
        ),
    )
    return parser.parse_args()


def iter_jsonl_files(root: Path, include_subagents: bool) -> Iterator[Path]:
    for dirpath, dirnames, filenames in os.walk(root):
        if not include_subagents and "subagents" in dirnames:
            dirnames.remove("subagents")
        dirnames.sort()
        for filename in sorted(filenames):
            if filename.endswith(".jsonl"):
                yield Path(dirpath) / filename


def make_attempt_key(session_id: str, tool_use_id: str) -> str:
    return session_id + "::" + tool_use_id


def preview(text: str, limit: int = 220) -> str:
    compact = " ".join(text.split())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 3] + "..."


def estimate_tokens(text: str) -> int:
    # Rough enough for output chunking. We intentionally bias slightly high.
    return max(1, (len(text) + 3) // 4)


def iter_blocks(message_content: object) -> Iterator[dict]:
    if not isinstance(message_content, list):
        return
    for block in message_content:
        if isinstance(block, dict):
            yield block


def extract_text(content: object) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""

    parts: List[str] = []
    for item in content:
        if isinstance(item, str):
            parts.append(item)
            continue
        if not isinstance(item, dict):
            continue
        if isinstance(item.get("text"), str):
            parts.append(item["text"])
        elif isinstance(item.get("content"), str):
            parts.append(item["content"])
    return "\n".join(part for part in parts if part)


def classify_reason_style(reason: Optional[str]) -> Optional[str]:
    if not reason:
        return None

    stripped = reason.lstrip()
    if (
        stripped.startswith("#")
        or stripped.startswith("YOUR PLAN WAS NOT APPROVED.")
        or "\n## " in reason
        or "\n---" in reason
    ):
        return "structured"
    return "freeform"


def extract_blockquote_feedback(text: str) -> List[str]:
    quotes: List[str] = []
    current: List[str] = []

    for raw_line in text.splitlines():
        stripped = raw_line.strip()
        if stripped.startswith(">"):
            current.append(stripped[1:].lstrip())
            continue

        if current:
            if not stripped or stripped.startswith("## ") or stripped == "---":
                quote = "\n".join(line for line in current if line).strip()
                if quote:
                    quotes.append(quote)
                current = []
                continue

            # Preserve wrapped continuation lines that belong to the same quote.
            current.append(stripped)

    if current:
        quote = "\n".join(line for line in current if line).strip()
        if quote:
            quotes.append(quote)

    return quotes


def extract_human_reason(
    native_reason: Optional[str],
    captured_reason: Optional[str],
    captured_reason_style: Optional[str],
) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    if native_reason:
        return (
            native_reason,
            classify_reason_style(native_reason),
            "native_inline_reason",
        )

    if not captured_reason:
        return (None, None, None)

    if captured_reason_style == "freeform":
        return (
            captured_reason,
            classify_reason_style(captured_reason),
            "non_native_freeform_payload",
        )

    quote_feedback = extract_blockquote_feedback(captured_reason)
    if quote_feedback:
        reason = "\n\n".join(quote_feedback)
        return (
            reason,
            classify_reason_style(reason),
            "structured_quote_extraction",
        )

    return (None, None, None)


def classify_result(
    text: str,
    is_error: bool,
) -> Tuple[str, Optional[str], Optional[str], Optional[str], Optional[str]]:
    stripped = text.strip()
    if not stripped:
        if is_error:
            return (
                "denied_non_native_no_payload",
                None,
                None,
                None,
                None,
            )
        return ("pending", None, None, None, None)

    if stripped.startswith(APPROVE_PREFIX):
        return ("approved_native", None, None, None, None)

    if stripped.startswith(REJECT_PREFIX):
        marker_index = stripped.find(REASON_MARKER)
        if marker_index < 0:
            return ("denied_native_no_reason", None, None, None, None)

        reason = stripped[marker_index + len(REASON_MARKER) :]
        note_index = reason.find(NOTE_MARKER)
        if note_index >= 0:
            reason = reason[:note_index]
        reason = reason.strip()
        if reason:
            style = classify_reason_style(reason)
            return (
                "denied_native_with_reason",
                reason,
                reason,
                "native_inline_reason",
                style,
            )
        return ("denied_native_no_reason", None, None, None, None)

    if is_error:
        style = classify_reason_style(stripped)
        return (
            "denied_non_native_with_payload",
            None,
            stripped,
            "non_native_error_payload",
            style,
        )

    return ("non_native_other", None, None, None, None)


def outcome_rank(outcome: str) -> int:
    ranks = {
        "pending": 0,
        "non_native_other": 1,
        "approved_native": 2,
        "denied_native_no_reason": 3,
        "denied_native_with_reason": 4,
        "denied_non_native_no_payload": 5,
        "denied_non_native_with_payload": 6,
    }
    return ranks.get(outcome, 0)


def update_attempt_from_result(
    attempt: AttemptRecord,
    file_path: Path,
    line_number: int,
    timestamp: Optional[str],
    text: str,
    is_error: bool,
) -> None:
    (
        outcome,
        native_reason,
        captured_reason,
        captured_reason_source,
        captured_reason_style,
    ) = classify_result(text=text, is_error=is_error)
    if outcome_rank(outcome) < outcome_rank(attempt.outcome):
        return

    attempt.outcome = outcome
    attempt.native_reason = native_reason
    attempt.native_reason_style = classify_reason_style(native_reason)
    attempt.captured_reason = captured_reason
    attempt.captured_reason_source = captured_reason_source
    attempt.captured_reason_style = captured_reason_style
    (
        attempt.human_reason,
        attempt.human_reason_style,
        attempt.human_reason_source,
    ) = extract_human_reason(
        native_reason=native_reason,
        captured_reason=captured_reason,
        captured_reason_style=captured_reason_style,
    )
    attempt.result_is_error = is_error
    attempt.result_file_path = str(file_path)
    attempt.result_line_number = line_number
    attempt.result_timestamp = timestamp
    attempt.result_preview = preview(text)


def scan_projects(
    projects_dir: Path,
    include_subagents: bool,
) -> Tuple[Dict[str, int], List[AttemptRecord]]:
    stats = {
        "files_scanned": 0,
        "lines_scanned": 0,
        "json_errors": 0,
    }
    attempts: Dict[str, AttemptRecord] = {}

    for file_path in iter_jsonl_files(projects_dir, include_subagents):
        stats["files_scanned"] += 1
        try:
            handle = file_path.open("r", encoding="utf-8", errors="replace")
        except OSError:
            continue

        with handle:
            for line_number, raw_line in enumerate(handle, start=1):
                if not raw_line.strip():
                    continue
                stats["lines_scanned"] += 1
                try:
                    obj = json.loads(raw_line)
                except json.JSONDecodeError:
                    stats["json_errors"] += 1
                    continue

                session_id = str(obj.get("sessionId") or str(file_path))
                timestamp = obj.get("timestamp")
                cwd = obj.get("cwd")
                message = obj.get("message")
                if not isinstance(message, dict):
                    continue

                content = message.get("content")

                for block in iter_blocks(content):
                    if (
                        block.get("type") == "tool_use"
                        and block.get("name") == "ExitPlanMode"
                        and isinstance(block.get("id"), str)
                    ):
                        tool_use_id = block["id"]
                        key = make_attempt_key(session_id, tool_use_id)
                        if key in attempts:
                            continue
                        input_data = block.get("input")
                        plan = None
                        plan_file_path = None
                        if isinstance(input_data, dict):
                            if isinstance(input_data.get("plan"), str):
                                plan = input_data["plan"]
                            if isinstance(input_data.get("planFilePath"), str):
                                plan_file_path = input_data["planFilePath"]

                        attempts[key] = AttemptRecord(
                            session_id=session_id,
                            tool_use_id=tool_use_id,
                            file_path=str(file_path),
                            line_number=line_number,
                            timestamp=timestamp if isinstance(timestamp, str) else None,
                            cwd=cwd if isinstance(cwd, str) else None,
                            plan_file_path=plan_file_path,
                            plan_length_chars=len(plan) if isinstance(plan, str) else None,
                        )

                if message.get("role") != "user":
                    continue

                for block in iter_blocks(content):
                    if (
                        block.get("type") != "tool_result"
                        or not isinstance(block.get("tool_use_id"), str)
                    ):
                        continue

                    key = make_attempt_key(session_id, block["tool_use_id"])
                    attempt = attempts.get(key)
                    if attempt is None:
                        continue

                    text = extract_text(block.get("content"))
                    update_attempt_from_result(
                        attempt=attempt,
                        file_path=file_path,
                        line_number=line_number,
                        timestamp=timestamp if isinstance(timestamp, str) else None,
                        text=text,
                        is_error=bool(block.get("is_error")),
                    )

    return stats, list(attempts.values())


def summarize(attempts: Iterable[AttemptRecord]) -> Dict[str, int]:
    summary = {
        "total_exit_plan_attempts": 0,
        "approved_native": 0,
        "denied_native_with_reason": 0,
        "denied_native_no_reason": 0,
        "denied_native_with_freeform_reason": 0,
        "denied_native_with_structured_reason": 0,
        "denied_non_native_with_payload": 0,
        "denied_non_native_no_payload": 0,
        "captured_denial_reasons_total": 0,
        "captured_freeform_reasons": 0,
        "captured_structured_reasons": 0,
        "human_reasons_total": 0,
        "human_reasons_native": 0,
        "human_reasons_non_native": 0,
        "human_reasons_freeform": 0,
        "human_reasons_structured": 0,
        "non_native_other": 0,
        "pending": 0,
    }
    for attempt in attempts:
        summary["total_exit_plan_attempts"] += 1
        summary[attempt.outcome] = summary.get(attempt.outcome, 0) + 1
        if attempt.outcome == "denied_native_with_reason":
            if attempt.native_reason_style == "freeform":
                summary["denied_native_with_freeform_reason"] += 1
            elif attempt.native_reason_style == "structured":
                summary["denied_native_with_structured_reason"] += 1
        if attempt.captured_reason:
            summary["captured_denial_reasons_total"] += 1
            if attempt.captured_reason_style == "freeform":
                summary["captured_freeform_reasons"] += 1
            elif attempt.captured_reason_style == "structured":
                summary["captured_structured_reasons"] += 1
        if attempt.human_reason:
            summary["human_reasons_total"] += 1
            if attempt.human_reason_source == "native_inline_reason":
                summary["human_reasons_native"] += 1
            else:
                summary["human_reasons_non_native"] += 1
            if attempt.human_reason_style == "freeform":
                summary["human_reasons_freeform"] += 1
            elif attempt.human_reason_style == "structured":
                summary["human_reasons_structured"] += 1
    return summary


def filter_records(
    attempts: List[AttemptRecord],
    records_filter: str,
) -> List[AttemptRecord]:
    if records_filter == "all":
        return attempts
    if records_filter == "native":
        return [
            attempt
            for attempt in attempts
            if attempt.outcome.startswith("approved_native")
            or attempt.outcome.startswith("denied_native")
        ]
    if records_filter == "native-denials":
        return [
            attempt
            for attempt in attempts
            if attempt.outcome.startswith("denied_native")
        ]
    if records_filter == "human-reasons":
        return [attempt for attempt in attempts if attempt.human_reason]
    return [
        attempt
        for attempt in attempts
        if attempt.outcome.startswith("denied_native")
        or attempt.outcome.startswith("denied_non_native")
    ]


def build_json_chunks(
    records: List[AttemptRecord],
    max_output_tokens_per_file: int,
) -> List[List[AttemptRecord]]:
    if not records:
        return [[]]

    chunks: List[List[AttemptRecord]] = []
    current_chunk: List[AttemptRecord] = []
    current_tokens = 0

    for record in records:
        record_dict = asdict(record)
        record_json = json.dumps(record_dict, ensure_ascii=False)
        record_tokens = estimate_tokens(record_json)

        if current_chunk and current_tokens + record_tokens > max_output_tokens_per_file:
            chunks.append(current_chunk)
            current_chunk = []
            current_tokens = 0

        current_chunk.append(record)
        current_tokens += record_tokens

    if current_chunk:
        chunks.append(current_chunk)

    return chunks


def print_summary(
    projects_dir: Path,
    include_subagents: bool,
    stats: Dict[str, int],
    attempts: List[AttemptRecord],
    summary: Dict[str, int],
    show_samples: int,
    include_non_native_denials: bool,
) -> None:
    native_denials = (
        summary["denied_native_with_reason"] + summary["denied_native_no_reason"]
    )
    total_denials = (
        native_denials
        + summary["denied_non_native_with_payload"]
        + summary["denied_non_native_no_payload"]
    )
    native_extractable_ratio = (
        (summary["denied_native_with_reason"] / native_denials) * 100.0
        if native_denials
        else 0.0
    )
    all_capture_ratio = (
        (summary["captured_denial_reasons_total"] / total_denials) * 100.0
        if total_denials
        else 0.0
    )

    print(f"Projects dir: {projects_dir}")
    print(f"Included subagents: {'yes' if include_subagents else 'no'}")
    print(f"JSONL files scanned: {stats['files_scanned']}")
    print(f"JSON lines scanned: {stats['lines_scanned']}")
    print(f"JSON parse errors: {stats['json_errors']}")
    print()
    print(f"ExitPlanMode attempts: {summary['total_exit_plan_attempts']}")
    print(f"Native approvals: {summary['approved_native']}")
    print(
        "Native denials with extractable reason: "
        f"{summary['denied_native_with_reason']}"
    )
    print(
        "Native denials without reason: "
        f"{summary['denied_native_no_reason']}"
    )
    print(
        "Freeform native reasons: "
        f"{summary['denied_native_with_freeform_reason']}"
    )
    print(
        "Structured native reasons: "
        f"{summary['denied_native_with_structured_reason']}"
    )
    print(
        "Non-native denials with payload: "
        f"{summary['denied_non_native_with_payload']}"
    )
    print(
        "Non-native denials without payload: "
        f"{summary['denied_non_native_no_payload']}"
    )
    print(
        "Captured denial reasons total: "
        f"{summary['captured_denial_reasons_total']}"
    )
    print(
        "Captured freeform reasons: "
        f"{summary['captured_freeform_reasons']}"
    )
    print(
        "Captured structured reasons: "
        f"{summary['captured_structured_reasons']}"
    )
    print(f"Human reasons total: {summary['human_reasons_total']}")
    print(f"Human reasons from native denials: {summary['human_reasons_native']}")
    print(
        "Human reasons from non-native denials: "
        f"{summary['human_reasons_non_native']}"
    )
    print(
        "Non-native / non-denial outcomes: "
        f"{summary['non_native_other']}"
    )
    print(f"Pending / unmatched attempts: {summary['pending']}")
    print()
    print(
        "Extractable native denial reasons: "
        f"{summary['denied_native_with_reason']}/{native_denials} "
        f"({native_extractable_ratio:.1f}%)"
    )
    print(
        "Captured denial payloads across all denial types: "
        f"{summary['captured_denial_reasons_total']}/{total_denials} "
        f"({all_capture_ratio:.1f}%)"
    )
    print(
        "Human reasons across all denial types: "
        f"{summary['human_reasons_total']}/{total_denials} "
        f"({((summary['human_reasons_total'] / total_denials) * 100.0 if total_denials else 0.0):.1f}%)"
    )

    if include_non_native_denials:
        samples = [attempt for attempt in attempts if attempt.human_reason]
    else:
        samples = [
            attempt
            for attempt in attempts
            if attempt.outcome == "denied_native_with_reason" and attempt.human_reason
        ]
    samples = samples[: max(show_samples, 0)]
    if not samples:
        return

    print()
    print(
        "Sample denial reasons:"
        if include_non_native_denials
        else "Sample native denial reasons:"
    )
    for attempt in samples:
        style = attempt.human_reason_style or "unknown"
        source = attempt.human_reason_source or "unknown"
        reason = attempt.human_reason or ""
        print(
            "- "
            f"[{attempt.outcome} / {source} / {style}] "
            f"{reason!r} "
            f"({attempt.file_path}:{attempt.result_line_number})"
        )


def write_json_report(
    output_path: Path,
    projects_dir: Path,
    include_subagents: bool,
    stats: Dict[str, int],
    summary: Dict[str, int],
    records: List[AttemptRecord],
    max_output_tokens_per_file: int,
) -> List[Path]:
    output_path.parent.mkdir(parents=True, exist_ok=True)

    chunks = build_json_chunks(records, max_output_tokens_per_file)
    base_name = output_path.stem
    output_dir = output_path.with_suffix("")
    output_dir.mkdir(parents=True, exist_ok=True)

    written_files: List[Path] = []
    part_summaries = []

    for index, chunk in enumerate(chunks, start=1):
        chunk_records = [asdict(record) for record in chunk]
        chunk_payload = {
            "projects_dir": str(projects_dir),
            "include_subagents": include_subagents,
            "stats": stats,
            "summary": summary,
            "part_index": index,
            "part_count": len(chunks),
            "record_count": len(chunk_records),
            "records": chunk_records,
        }
        part_name = f"{base_name}.part-{index:04d}-of-{len(chunks):04d}.json"
        part_path = output_dir / part_name
        part_path.write_text(
            json.dumps(chunk_payload, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        written_files.append(part_path)
        part_summaries.append(
            {
                "part_index": index,
                "file_name": part_name,
                "record_count": len(chunk_records),
            }
        )

    manifest_payload = {
        "projects_dir": str(projects_dir),
        "include_subagents": include_subagents,
        "stats": stats,
        "summary": summary,
        "records_filter_record_count": len(records),
        "part_count": len(chunks),
        "max_output_tokens_per_file": max_output_tokens_per_file,
        "parts": part_summaries,
    }
    manifest_path = output_dir / f"{base_name}.manifest.json"
    manifest_path.write_text(
        json.dumps(manifest_payload, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    written_files.insert(0, manifest_path)

    return written_files


def main() -> int:
    args = parse_args()
    projects_dir = Path(args.projects_dir).expanduser()
    if not projects_dir.exists():
        print(f"Projects dir does not exist: {projects_dir}", file=sys.stderr)
        return 1

    stats, attempts = scan_projects(
        projects_dir=projects_dir,
        include_subagents=args.include_subagents,
    )
    attempts.sort(
        key=lambda attempt: (
            attempt.file_path,
            attempt.line_number,
            attempt.tool_use_id,
        )
    )
    summary = summarize(attempts)
    records = filter_records(attempts, args.records_filter)

    print_summary(
        projects_dir=projects_dir,
        include_subagents=args.include_subagents,
        stats=stats,
        attempts=attempts,
        summary=summary,
        show_samples=args.show_samples,
        include_non_native_denials=args.include_non_native_denials,
    )

    if args.json_out:
        written_files = write_json_report(
            output_path=Path(args.json_out).expanduser(),
            projects_dir=projects_dir,
            include_subagents=args.include_subagents,
            stats=stats,
            summary=summary,
            records=records,
            max_output_tokens_per_file=args.max_output_tokens_per_file,
        )
        part_count = max(len(written_files) - 1, 0)
        print()
        print(
            "Wrote JSON output: "
            f"detected {len(records)} records for filter '{args.records_filter}' "
            f"and emitted {part_count} part file(s) plus a manifest."
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
