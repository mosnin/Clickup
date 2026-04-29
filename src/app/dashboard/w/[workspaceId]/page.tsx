import { notFound } from "next/navigation";
import { mockTeamWorkspaces } from "@/lib/mock-data";

export default async function WorkspacePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;

  // TODO(convex): replace with `useQuery(api.workspaces.get, { id })` once
  // Convex generated client is available.
  const workspace = mockTeamWorkspaces.find((w) => w.id === workspaceId);
  if (!workspace) notFound();

  return (
    <div className="space-y-8">
      <header>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {workspace.name}
          </h1>
          <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs uppercase tracking-wider text-muted-foreground">
            {workspace.role}
          </span>
        </div>
      </header>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Spaces
        </h2>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {workspace.spaces.map((space) => (
            <li
              key={space.id}
              id={space.id}
              className="rounded-3xl border border-border bg-background p-5"
            >
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="inline-block h-3 w-3 rounded-full"
                  style={{ backgroundColor: space.color }}
                />
                <span className="font-medium">{space.name}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
