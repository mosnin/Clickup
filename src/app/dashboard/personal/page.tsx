"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Stagger, StaggerItem } from "@/components/motion";

export default function PersonalPage() {
  const tree = useQuery(api.sidebar.tree, {});

  if (tree === undefined) {
    return <Skeleton />;
  }
  if (tree === null || !tree.personal) {
    return (
      <div className="rounded-2xl border border-border bg-muted/30 p-10 text-center text-sm text-muted-foreground">
        Setting up your personal space…
      </div>
    );
  }

  const { personal } = tree;
  const directLists = personal.lists;

  return (
    <div className="space-y-6">
      <header className="title-rule">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-3 w-3 rounded-full"
            style={{ backgroundColor: personal.color ?? "#a9c6f2" }}
          />
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            {personal.name}
          </h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Just for you. Nothing in here is shared.
        </p>
      </header>

      {personal.folders.length === 0 && directLists.length === 0 ? (
        <div className="rounded-2xl bento p-10 text-center">
          <p className="text-sm text-muted-foreground">
            No lists yet. Use the <span className="font-medium">+</span> next to{" "}
            <span className="font-medium">{personal.name}</span> in the sidebar
            to add a list or folder.
          </p>
        </div>
      ) : (
        <>
          {personal.folders.map((folder) => (
            <section key={folder._id}>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                {folder.name}
              </h2>
              <Stagger className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {folder.lists.map((list) => (
                  <ListCard key={list._id} list={list} />
                ))}
              </Stagger>
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
        className="lift block rounded-2xl bento p-5 hover:border-foreground/25"
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
            className="h-24 animate-pulse rounded-2xl border border-border bg-muted/40"
          />
        ))}
      </div>
    </div>
  );
}
