# 001. Recreate Deleted Source Files on Save

Date: 2026-06-18

## Status

Accepted

## Context

Plannotator can edit local source-backed files during annotate sessions. It watches disk changes so the editor can update clean files, warn on dirty conflicts, and avoid sending stale saved edit context.

A review found that when a watched file is deleted or renamed outside Plannotator, the disk-sync path can collapse the missing file into a no-op. That leaves the last loaded editor text and any Edits context looking current even though the file no longer exists at the backing path.

We considered treating deletion as a special recovery workflow with choices such as recreate, discard, or reload. That is heavier than needed. The desired behavior is closer to VS Code: keep the open editor contents, notify the user that the backing file disappeared, and let Save write the current contents back to the same path.

## Decision

When a source-backed file is missing on disk, Plannotator will keep the in-memory editor contents open and visible. It will notify the user that the file no longer exists at its path.

Save remains available. If the user saves, Plannotator recreates the file at the same path with the current editor contents and returns to normal source-save tracking.

Missing is not the same as unavailable. A confirmed missing file can update the document state and clear or stale saved edit context for that path. A transient unavailable read must not destructively clear state.

Plannotator will not add a separate recreate/discard modal for this case. Closing or discarding the open document drops the in-memory copy. Reload is not offered when there is no disk file to reload.

Saved Edits context for a missing file must not be sent as if it still describes a current disk file. Feedback submission still validates source-file context before sending.

External text changes continue to follow the existing conflict policy: if the user has no unsaved edits, Plannotator updates to the new disk contents and clears stale saved Edits; if the user has unsaved edits, Plannotator warns and asks the user to choose between their buffer and the disk version.

## Consequences

The source document probe must distinguish `ok`, `missing`, and `unavailable` results. Live disk reconciliation must handle missing files explicitly instead of treating them as null snapshots.

The source-save endpoint must allow safe recreation of a previously opened source file at the same path. The UI must show a simple missing-file warning while preserving the editor text.

This keeps behavior familiar and avoids overbuilt recovery UI, but it means the save path now owns safe file recreation for previously opened files.

Tests should cover missing versus unavailable reads, clearing or staling saved Edits for a missing backing file, and saving a missing source file back to disk.
