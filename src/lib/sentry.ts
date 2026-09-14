// Browser / Next.js error reporter. Same contract as convex/_sentry.ts:
// unset DSN is supported and is the default.

export function reportClientError(
  error: unknown,
  context?: Record<string, string>,
): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message, context);
  const dsn =
    process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn || typeof fetch === "undefined") return;
  try {
    const parsed = parseDsn(dsn);
    if (!parsed) return;
    void fetch(`${parsed.storeUrl}?sentry_key=${parsed.key}&sentry_version=7`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        level: "error",
        extra: context ?? {},
        timestamp: Date.now() / 1000,
        platform: "javascript",
      }),
    }).catch(() => {
      // Reporting must never become the incident.
    });
  } catch {
    // ignore
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
