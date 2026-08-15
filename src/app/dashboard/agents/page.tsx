import { Suspense } from "react";
import { AgentsView } from "./agents-view";

export default function AgentsPage() {
  // AgentsView reads ?tab= via useSearchParams, which needs a Suspense
  // boundary when the route is statically prerendered.
  return (
    <Suspense>
      <AgentsView />
    </Suspense>
  );
}
