# Refactor Auth Module

Current approach: keep the existing middleware, add a thin shim that records
session token usage so we can measure the legacy code paths before deciding
whether to remove them.

## Steps

1. Add an audit shim around the existing middleware.
2. Log the call sites for two weeks.
3. Decide whether to delete the legacy paths based on the data.
