import type { Metadata } from "next";
import Link from "next/link";
import { PlanCanvas } from "@/components/dashboard/plan-canvas";

export const metadata: Metadata = {
  title: "Plan",
  robots: { index: false, follow: false },
};

// The plan gets a route rather than a tab because it is a place people go to
// think, and a place you can link somebody to. "See the plan" has to be a URL
// or it is not a shared artifact — which is the entire complaint against
// deliberation living in a chat scroll.

export default async function PlanRoute({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return (
    <div className="space-y-4">
      <Link
        href={`/dashboard/p/${projectId}`}
        className="text-tiny text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
      >
        ← Back to the project
      </Link>
      <PlanCanvas projectId={projectId} />
    </div>
  );
}
