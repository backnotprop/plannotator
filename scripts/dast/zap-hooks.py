"""Deterministic hooks for Plannotator's packaged ZAP baseline scan."""


def zap_access_target(zap, target):
    # Seed the real read-only application routes through ZAP so passive rules
    # inspect the SPA plus its JSON/error responses without invoking any
    # state-changing endpoint.
    for path in (
        "",
        "/api/plan",
        "/api/ai/capabilities",
        "/api/definitely-missing",
    ):
        response = zap.urlopen(target.rstrip("/") + path)
        if response.startswith("ZAP Error"):
            raise RuntimeError(f"ZAP failed to seed {path or '/'}: {response}")
    return zap, target


def zap_tuned(zap):
    # Dependency CVEs are owned by Trivy (repository) and Grype (release).
    # ZAP rule 10003 also tries to store the entire 20+ MiB single-file bundle
    # as alert evidence, exceeding ZAP's 16 MiB alert-column limit and turning
    # a redundant check into an engine error. Disable only that rule; the
    # remaining passive web rules continue to inspect the full response.
    # 10109 (Modern App Detection) similarly captures the full HTML response
    # as evidence; its informational classification is not a vulnerability
    # decision and exceeds the same alert-column limit for this bundle.
    zap.pscan.disable_scanners("10003,10109")


def zap_spider(zap, target):
    # The traditional spider treats strings inside Plannotator's 20+ MiB
    # single-file JavaScript bundle as links. Send that spider to a small,
    # read-only API 404 instead. (The favicon path is handled by the SPA
    # fallback and therefore returns the full bundle.) zap_access_target above
    # seeds the real UI/API responses through the passive scanner. Keeping the
    # spider on the application origin also keeps detector-fixture findings out
    # of the application report.
    if target.rstrip("/").endswith(":19432"):
        return zap, target.rstrip("/") + "/api/definitely-missing"
    return zap, target
