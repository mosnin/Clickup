import { Suspense } from "react";
import type { Metadata } from "next";
import { SpacesView } from "../projects/spaces-view";

export const metadata: Metadata = {
  title: "Spaces",
  robots: { index: false, follow: false },
};

export default function SpacesPage() {
  return (
    <Suspense>
      <SpacesView />
    </Suspense>
  );
}
