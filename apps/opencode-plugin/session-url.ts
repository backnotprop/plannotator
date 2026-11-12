export function announceSessionUrl(client: any, label: string, url: string): void {
  const message = `Open ${label}: ${url}`;
  try {
    void client?.app?.log?.({ level: "info", message: `[Plannotator] ${message}` });
  } catch {
  }
  try {
    const result = client?.tui?.showToast?.({
      body: { title: "Plannotator", message, variant: "info" },
    });
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {
  }
}
