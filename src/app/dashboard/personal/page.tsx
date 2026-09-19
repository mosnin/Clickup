"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Stagger, StaggerItem } from "@/components/motion";
import { PageHeader } from "@/components/dashboard/page-header";
import { EmptyState } from "@/components/dashboard/empty-state";

export default function PersonalPage() {
  const tree = useQuery(api.sidebar.tree, {});

  if (tree === undefined) {
    return <Skeleton />;
  }
  if (tree === null || !tree.personal) {
    return (
      <div className="rounded-2xl bg-muted/30 p-10 text-center text-sm text-muted-foreground">
        Setting up your personal space…
      </div>
    );
  }

  const { personal } = tree;
  const directLists = personal.lists;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Personal"
        description="Just for you. Nothing in here is shared."
      />

      {personal.projects.length === 0 && directLists.length === 0 ? (
        <EmptyState
          title="Nothing here yet"
          message={`Add a list or project next to ${personal.name} in the sidebar.`}
        />
      ) : (
        <>
          {personal.projects.map((project) => (
            <section key={project._id}>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                {project.name}
              </h2>
              {project.lists.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  This project is empty. Add a list to it from the sidebar.
                </p>
              ) : (
                <Stagger className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {project.lists.map((list) => (
                    <ListCard key={list._id} list={list} />
                  ))}
                </Stagger>
              )}
            </section>
          ))}

          {directLists.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Lists
              </h2>
              <Stagger className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {directLists.map((list) => (
                  <ListCard key={list._id} list={list} />
                ))}
              </Stagger>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function ListCard({
  list,
}: {
  list: { _id: string; name: string; color?: string };
}) {
  return (
    <StaggerItem>
      <Link
        href={`/dashboard/l/${list._id}`}
        className="lift block rounded-2xl panel p-5 hover:border-foreground/25"
      >
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: list.color ?? "#a9c6f2" }}
          />
          <span className="font-medium">{list.name}</span>
        </div>
      </Link>
    </StaggerItem>
  );
}

function Skeleton() {
  return (
    <div className="space-y-4">
      <div className="h-8 w-1/3 animate-pulse rounded-full bg-muted" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-2xl bg-muted/40"
          />
        ))}
      </div>
    </div>
  );
}
