import { Suspense } from "react";
import type { Metadata } from "next";
import { ProjectsView } from "./projects-view";

export const metadata: Metadata = {
  title: "Projects",
  robots: { index: false, follow: false },
};

export default function ProjectsPage() {
  // ProjectsView reads ?sort=/?group= via useSearchParams, which requires
  // a Suspense boundary when the route is statically prerendered.
  return (
    <Suspense>
      <ProjectsView />
    </Suspense>
  );
}
