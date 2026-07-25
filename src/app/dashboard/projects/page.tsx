import { Suspense } from "react";
import type { Metadata } from "next";
import { SpacesView } from "./spaces-view";

export const metadata: Metadata = {
  title: "Spaces",
  robots: { index: false, follow: false },
};

export default function ProjectsPage() {
  return (
    <Suspense>
      <SpacesView />
    </Suspense>
  );
}
