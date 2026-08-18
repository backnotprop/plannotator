# Isolated OWASP ZAP DAST

The `ZAP DAST` workflow runs a passive baseline scan against a disposable
Plannotator annotate session. Both the application and ZAP run on a Docker
network created with `--internal`, so neither can reach production or any
external service. No repository, cloud, npm, model-provider, or user
credentials are passed to either container.

The workflow is intentionally scheduled/manual rather than part of every PR:

```bash
gh workflow run dast.yml --repo backnotprop/plannotator
```

Each run retains the human-readable HTML report, machine-readable JSON report,
Markdown report, target/scanner logs, and a small evidence manifest for 30
days. Findings are initially monitor-only. Missing targets, empty coverage,
malformed reports, scanner failures, and failure to detect the controlled
passive-scan fixture fail the workflow.

The scan hook seeds `/`, `/api/plan`, the disabled-AI capabilities response,
and an unknown-API 404 through ZAP. The traditional spider is confined to that
small API 404 because parsing the single-file bundle as static HTML creates
false link candidates. A read-only route guard forwards those approved GET
routes to the real annotate server and returns small 404 responses for crawler
metadata or any other path. It also rejects every state-changing HTTP method.
Browser/AJAX crawling was evaluated and deferred: ZAP's pinned image does not
carry a WebDriver and an internal network correctly prevents downloading one
at runtime. This keeps the scan deterministic and offline while still
passively inspecting real Plannotator UI and API responses.

ZAP passive rule `10003` (Vulnerable JS Library) is disabled deliberately.
Trivy owns repository dependency detection and Grype owns release dependency
decisions. On Plannotator's 20+ MiB single-file bundle, rule `10003` also tries
to store the complete bundle as alert evidence and exceeds ZAP's alert-column
limit. Informational rule `10109` (Modern App Detection) is disabled for the
same evidence-size reason; it is not a vulnerability decision. All other
passive web rules still receive the full response.

The same large response exceeds the 32 MiB cache in ZAP's stock HSQLDB
template once scan metadata is included. At run time, the workflow extracts
that template from the digest-pinned image, verifies the expected setting,
changes only the cache limit to 128 MiB, and mounts the derived template
read-only. The validator fails closed if ZAP reports cache exhaustion, disk
exhaustion, or a response-size truncation.

The target entry point refuses to start unless
`PLANNOTATOR_DAST_ISOLATED=1`. Do not set that acknowledgement outside an
isolated disposable environment. The workflow is the supported execution
path; the target is not a production server.
