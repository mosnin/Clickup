// Capture exceptions from Convex Node actions when SENTRY_DSN is set.
// Unset is supported: we log and return. Never throw from here — reporting
// must not take down the action that failed.

export function reportActionError(
  error: unknown,
  context?: Record<string, string>,
): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message, context);
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  try {
    const parsed = parseDsn(dsn);
    if (!parsed) return;
    const payload = {
      message,
      level: "error",
      extra: context ?? {},
      timestamp: Date.now() / 1000,
      platform: "node",
    };
    void fetch(`${parsed.storeUrl}?sentry_key=${parsed.key}&sentry_version=7`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch((sendErr) => {
      console.error("Sentry report failed", sendErr);
    });
  } catch (sendErr) {
    console.error("Sentry report failed", sendErr);
  }
}

function parseDsn(
  dsn: string,
): { storeUrl: string; key: string } | null {
  try {
    const url = new URL(dsn);
    const key = url.username;
    const project = url.pathname.replace(/^\//, "");
    if (!key || !project) return null;
    return {
      storeUrl: `${url.protocol}//${url.host}/api/${project}/store/`,
      key,
    };
  } catch {
    return null;
  }
}
