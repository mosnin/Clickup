"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Folder, List as ListIcon, Plus, Star } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";
import { EmptyState } from "@/components/dashboard/empty-state";
import { InlineCreate } from "@/components/dashboard/inline-create";
import { AttachedPages } from "@/components/dashboard/attached-pages";
import {
  ProjectNotesCard,
  ProjectOwnerCard,
  ProjectStatusCard,
  ProjectTargetDateCard,
} from "@/components/dashboard/project-meta-cards";
import { Stagger, StaggerItem } from "@/components/motion";
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
  const createList = useMutation(api.lists.create);
  const updateMeta = useMutation(api.projects.updateMeta);
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);

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

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <div className="min-w-0 space-y-6">
          <Card className="rounded-2xl p-5">
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              About
            </span>
            <input
              defaultValue={project.description ?? ""}
              placeholder="What is this project about?"
              aria-label="Project description"
              onBlur={(e) => {
                const next = e.currentTarget.value;
                if (next === (project.description ?? "")) return;
                void updateMeta({ projectId: project._id, description: next })
                  .then(() => toast("Saved"))
                  .catch((err) =>
                    toast(errorMessage(err, "Couldn't save description"), {
                      kind: "error",
                    }),
                  );
              }}
              className="mt-2 w-full bg-transparent text-sm focus:outline-none"
            />
          </Card>

          <section>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Lists
              </h2>
              {!creating && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCreating(true)}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add list
                </Button>
              )}
            </div>

            {creating && (
              <div className="mt-3">
                <InlineCreate
                  placeholder="List name…"
                  onCancel={() => setCreating(false)}
                  onSubmit={async (name) => {
                    try {
                      await createList({
                        parentType: "project",
                        parentId: project._id,
                        name,
                      });
                      setCreating(false);
                    } catch (e) {
                      toast(errorMessage(e, "Couldn't create the list"), {
                        kind: "error",
                      });
                    }
                  }}
                />
              </div>
            )}

            {lists.length === 0 && !creating ? (
              <div className="mt-3">
                <EmptyState
                  compact
                  title="No lists yet"
                  message="A list is one board of tasks inside this project — Backlog, Milestones, whatever the work needs."
                  action={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCreating(true)}
                    >
                      Add a list
                    </Button>
                  }
                />
              </div>
            ) : (
              <Stagger className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {lists.map((l) => (
                  <StaggerItem key={l._id}>
                    <Link href={`/dashboard/l/${l._id}`} className="lift block">
                      <Card className="rounded-2xl p-4">
                        <div className="flex items-center gap-2">
                          <ListIcon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                          <span className="truncate text-sm font-medium">
                            {l.name}
                          </span>
                        </div>
                        {l.description && (
                          <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">
                            {l.description}
                          </p>
                        )}
                      </Card>
                    </Link>
                  </StaggerItem>
                ))}
              </Stagger>
            )}
          </section>
        </div>

        <div className="space-y-6">
          <AttachedPages targetType="project" targetId={project._id} />
          <ProjectStatusCard project={project} />
          <ProjectOwnerCard project={project} anyListId={lists[0]?._id} />
          <ProjectTargetDateCard project={project} />
          <ProjectNotesCard project={project} />
        </div>
      </div>
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
