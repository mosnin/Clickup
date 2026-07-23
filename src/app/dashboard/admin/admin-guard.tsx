"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Card } from "@/components/ui/card";

// Client-side gate for the admin console. The REAL security boundary is
// every admin Convex function calling requirePlatformAdmin — this guard is
// purely a UX affordance so non-admins never see a broken shell. Data
// never leaks: all admin queries throw for non-admins regardless of route.
export function AdminGuard({ children }: { children: React.ReactNode }) {
  const me = useQuery(api.admin.me, {});
  const router = useRouter();

  useEffect(() => {
    if (me === null) {
      const t = setTimeout(() => router.replace("/dashboard"), 1800);
      return () => clearTimeout(t);
    }
  }, [me, router]);

  if (me === undefined) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-48 animate-pulse rounded-full bg-muted" />
        <Card className="h-64 animate-pulse bg-muted/40" />
      </div>
    );
  }

  if (me === null) {
    return (
      <div className="mx-auto max-w-md pt-16 text-center">
        <h1 className="text-xl font-bold tracking-tight">
          Admin access required
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          This area is restricted to platform administrators. Taking you back
          to your dashboard…
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
