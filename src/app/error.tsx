"use client";

import { useEffect } from "react";
import { RefreshCw } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Button } from "@/components/ui/button";

// App Router error boundary. Without this file, any uncaught client throw
// becomes Next.js's generic "Application error: a client-side exception
// has occurred" page — which is what production rendered after login when
// Home's overview query threw on a duplicated personal-space row.

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Application failed to load", error);
  }, [error]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-6">
      <EmptyState
        title="This page hit a problem"
        message="Your work is safe. Try loading it again."
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
