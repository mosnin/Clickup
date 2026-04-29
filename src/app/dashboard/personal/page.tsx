import type { Metadata } from "next";
import { mockPersonalSpaces } from "@/lib/mock-data";

export const metadata: Metadata = { title: "Personal" };

export default function PersonalPage() {
  const space = mockPersonalSpaces[0];
  return (
    <div className="space-y-6">
      <header>
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-3 w-3 rounded-full"
            style={{ backgroundColor: space.color }}
          />
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {space.name}
          </h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Just for you. Nothing in here is shared with anyone.
        </p>
      </header>

      <div className="rounded-3xl border border-dashed border-border bg-muted/30 p-10 text-center">
        <p className="text-sm text-muted-foreground">
          Lists, tasks, and docs will live here once Convex queries are wired up.
        </p>
      </div>
    </div>
  );
}
