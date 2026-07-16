"use client";

// Guard for app routes that need the Convex backend. The marketing site is
// designed to render without NEXT_PUBLIC_CONVEX_URL (providers.tsx skips the
// ConvexProvider when it's unset) — but any page that calls useQuery/
// useMutation would then crash with "Could not find Convex client!". This
// turns that white-screen crash into an actionable message.
//
// NEXT_PUBLIC_* is inlined at build time, so this check is static per build:
// setting the var requires a redeploy to take effect.
const CONFIGURED = Boolean(process.env.NEXT_PUBLIC_CONVEX_URL);

export function RequireBackend({ children }: { children: React.ReactNode }) {
  if (!CONFIGURED) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-page p-6">
        <div className="bento max-w-md rounded-2xl p-8">
          <h1 className="text-lg font-bold tracking-tight">
            Backend not configured
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            This deployment was built without{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              NEXT_PUBLIC_CONVEX_URL
            </code>
            , so the app can&apos;t reach its database. Set it to your Convex
            deployment URL (e.g.{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              https://&lt;deployment&gt;.convex.cloud
            </code>
            ) in your hosting environment variables, then redeploy, the value
            is inlined at build time.
          </p>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
