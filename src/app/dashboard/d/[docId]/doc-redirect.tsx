"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { EmptyState } from "@/components/dashboard/empty-state";

// `/dashboard/d/:docId` — a bookmark from before Docs and Pages became one
// thing.
//
// Docs were folded into Pages: two features with the same icon and the same
// affordance gave people no way to choose between them, so their writing
// scattered across both. The old URL still resolves — a link someone saved
// last month should not 404 because the product got simpler.

export function DocRedirect({ docId }: { docId: string }) {
  const router = useRouter();
  const pageId = useQuery(api.pages.pageForLegacyDoc, { docId });

  useEffect(() => {
    if (pageId) router.replace(`/dashboard/pages/${pageId}`);
  }, [pageId, router]);

  if (pageId === undefined) {
    return <div className="h-32 animate-pulse rounded-2xl bg-muted" />;
  }
  if (pageId) return null;

  return (
    <EmptyState
      title="This document has moved"
      message="Docs and Pages are one thing now. If this document was yours, it's in Pages under the same title — search for it there."
      action={
        <Link
          href="/dashboard/pages"
          className="text-sm font-medium underline underline-offset-4"
        >
          Open Pages
        </Link>
      }
    />
  );
}
