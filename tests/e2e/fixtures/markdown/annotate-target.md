# Project Charter

This document is the target for the `plannotator annotate` end-to-end tests.
It is intentionally short, ordinary Markdown so annotations applied against
specific blocks have stable selectors.

## Goals

1. Ship the new pricing page by the end of the quarter.
2. Reduce the size of the published JS bundle by 20%.
3. Migrate analytics off the legacy ingestion pipeline.

## Out of scope

- Internationalization of the marketing site.
- Replacing the design system component library.

## Risks

The legacy ingestion pipeline is shared with the mobile clients. We must
coordinate the migration with the mobile team's release schedule.
