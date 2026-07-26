"use client";

import { useEffect } from "react";
import { LayoutTemplate, RefreshCw } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { PageHeader } from "@/components/dashboard/page-header";
import { Button } from "@/components/ui/button";

export default function TemplatesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Template Center failed to load", error);
  }, [error]);

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader icon={LayoutTemplate} title="Templates" />
      <EmptyState
        title="Templates are taking a moment"
        message="Your workspace is safe. Try loading the catalog again."
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
