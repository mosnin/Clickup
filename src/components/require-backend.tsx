"use client";

// Guard for app routes that need the Convex backend. The marketing site is
// designed to render without NEXT_PUBLIC_CONVEX_URL (providers.tsx skips the
// ConvexProvider when it's unset) — but any page that calls useQuery/
// useMutation would then crash with "Could not find Convex client!". This
// turns that white-screen crash into an actionable message.
//
// NEXT_PUBLIC_* is inlined at build time, so this check is static per build:
// setting the var requires a redeploy to take effect.
//
// The second guard is the one that was missing, and its absence cost a
// production outage that ran for DAYS without a single error on screen: the
// var was SET, but set to a deployment that had been deleted — every request
// 404'd, every query hung as a skeleton forever, and the app looked like "the
// database doesn't work" with nothing anywhere saying why. An unreachable
// backend and a slow backend are indistinguishable to a person; the watchdog
// below makes them distinguishable — if the socket has never connected after
// ~10 seconds, the app SAYS SO, with the URL it was built against, instead of
// letting skeletons stand in for an outage.
import { useEffect, useState } from "react";
import { useConvex } from "convex/react";
import { TerminalSurface } from "@/components/terminal-surface";

const CONFIGURED = Boolean(process.env.NEXT_PUBLIC_CONVEX_URL);

function BackendWatchdog({ children }: { children: React.ReactNode }) {
  const convex = useConvex();
  const [dead, setDead] = useState(false);
  useEffect(() => {
    // The gallery harness stubs `useConvex` with a plain object; the optional
    // call keeps the watchdog a no-op anywhere the real client is absent.
    if (typeof convex?.connectionState !== "function") return;
    let failures = 0;
    const id = setInterval(() => {
      const state = convex.connectionState();
      if (state.isWebSocketConnected) {
        failures = 0;
        setDead(false);
      } else if (typeof navigator !== "undefined" && !navigator.onLine) {
        // Their wifi, not our backend — the offline indicator owns that story.
        failures = 0;
      } else if (++failures >= 4) {
        setDead(true);
      }
    }, 2500);
    return () => clearInterval(id);
  }, [convex]);

  if (dead) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-page p-6">
        <div className="panel max-w-md overflow-hidden rounded-2xl">
          <TerminalSurface
            className="h-24"
            contentClassName="flex h-full items-end px-8 pb-3"
            tint="#e0685c"
          >
            <span className="font-mono text-[11px] tracking-wider text-white/70">
              backend unreachable
            </span>
          </TerminalSurface>
          <div className="p-8">
            <h1 className="text-lg font-bold tracking-tight">
              Can&apos;t reach the database
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              This build is wired to{" "}
              <code className="break-all rounded bg-muted px-1 py-0.5 text-xs">
                {process.env.NEXT_PUBLIC_CONVEX_URL}
              </code>{" "}
              and that deployment is not answering. Nothing will load or save
              until the hosting environment&apos;s{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                NEXT_PUBLIC_CONVEX_URL
              </code>{" "}
              points at a live Convex deployment and the site is redeployed.
            </p>
          </div>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

export function RequireBackend({ children }: { children: React.ReactNode }) {
  if (!CONFIGURED) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-page p-6">
        <div className="panel max-w-md overflow-hidden rounded-2xl">
          <TerminalSurface
            className="h-24"
            contentClassName="flex h-full items-end px-8 pb-3"
            tint="#e0685c"
          >
            <span className="font-mono text-[11px] tracking-wider text-white/70">
              no backend connection
            </span>
          </TerminalSurface>
          <div className="p-8">
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
      </div>
    );
  }
  return <BackendWatchdog>{children}</BackendWatchdog>;
}
