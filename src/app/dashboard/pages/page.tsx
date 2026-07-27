import { Suspense } from "react";
import type { Metadata } from "next";
import { PagesIndex } from "./pages-index";

export const metadata: Metadata = {
  title: "Pages",
  robots: { index: false, follow: false },
};

export default function PagesRoute() {
  // PagesIndex reads ?scope= via useSearchParams, which needs a Suspense
  // boundary when the route is statically prerendered.
  return (
    <Suspense>
      <PagesIndex />
    </Suspense>
  );
}
