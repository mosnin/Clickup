"use client";

import { useEffect } from "react";
import { RefreshCw } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { PageHeader } from "@/components/dashboard/page-header";
import { Button } from "@/components/ui/button";

// Keeps the dashboard shell (sidebar, appearance, toasts) standing when a
// page throws. The root `app/error.tsx` still catches throws from this
// layout itself.

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Dashboard failed to load", error);
  }, [error]);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader headline={false} title="Dashboard" />
      <EmptyState
        title="This screen hit a problem"
        message="Your workspace is safe. Try loading it again."
        action={
          <Button type="button" variant="outline" onClick={reset}>
            <RefreshCw aria-hidden />
            Try again
          </Button>
        }
      />
    </div>
  );
}
