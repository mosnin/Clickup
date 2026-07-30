"use client";

import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { Folder, Star } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { PageHeader } from "@/components/dashboard/page-header";
import { EmptyState } from "@/components/dashboard/empty-state";
import { ProjectScreen } from "@/components/dashboard/project-screen/project-screen";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

// The Project page: what the project is, who owns it, when it's due, and the
// lists inside it. A Project sits between a Space and its Lists, so this page
// is the level at which people talk about work — "how is the billing
// migration going" — rather than "how is board 3 of the billing migration
// going", which is what a list page answers.

export function ProjectView({ projectId }: { projectId: string }) {
  const data = useQuery(api.projects.get, {
    projectId: projectId as Id<"projects">,
  });
  const favorites = useQuery(api.favorites.listForCurrentUser, {});
  const toggleFavorite = useMutation(api.favorites.toggle);
  const { toast } = useToast();

  if (data === undefined) return <ProjectSkeleton />;
  if (data === null) {
    return (
      <EmptyState
        title="Project not found"
        message="It may have been deleted, or you may not have access to the space it lives in."
      />
    );
  }

  const { project, lists, spaceName, spaceId } = data;
  // The scope the project's space belongs to — already carried by
  // `projects.get`, and what user-authored panels are offered against.
  const scope = {
    scopeType: data.scopeType as "user" | "workspace",
    scopeId: data.scopeParentId as string,
  };
  const favorited = (favorites ?? []).some(
    (f) => f.entityType === "project" && f.entityId === project._id,
  );

  return (
    <div className="space-y-8">
      <PageHeader
        icon={Folder}
        title={project.name}
        context={
          <Link
            href={`/dashboard/s/${spaceId}`}
            className="hover:text-foreground"
          >
            {spaceName}
          </Link>
        }
        actions={
          <button
            type="button"
            aria-pressed={favorited}
            aria-label={
              favorited
                ? `Remove ${project.name} from favorites`
                : `Add ${project.name} to favorites`
            }
            onClick={() => {
              void toggleFavorite({
                entityType: "project",
                entityId: project._id,
              }).catch((e) =>
                toast(errorMessage(e, "Couldn't update favorites"), {
                  kind: "error",
                }),
              );
            }}
            className={cn(
              "tap-target inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors",
              favorited
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Star
              className="h-4 w-4"
              fill={favorited ? "currentColor" : "none"}
            />
          </button>
        }
      />

      {/* Everything below the header is composed by the person reading it. The
          panels are the same components that used to be hard-coded here; what
          changed is that their order and width are now data. */}
      <ProjectScreen
        project={project}
        lists={lists}
        spaceId={spaceId}
        spaceName={spaceName}
        scope={scope}
      />
    </div>
  );
}

function ProjectSkeleton() {
  return (
    <div className="space-y-8">
      <div className="h-8 w-56 animate-pulse rounded-lg bg-muted" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <div className="h-24 animate-pulse rounded-2xl bg-muted" />
          <div className="h-40 animate-pulse rounded-2xl bg-muted" />
        </div>
        <div className="space-y-6">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-2xl bg-muted"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
