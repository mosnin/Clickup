"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Plus } from "lucide-react";
import { api } from "@convex/_generated/api";
import { Card } from "@/components/ui/card";
import { InlineCreate } from "@/components/dashboard/inline-create";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import { timeAgo } from "@/lib/time";

// The pages pinned to one thing, shown where the work is.
//
// Deliberately small: a list of links and a way to add one. Pages have their
// own surface; this is a pointer to it, not a second editor. It renders
// nothing at all when there's nothing pinned and the viewer isn't adding —
// context you haven't written shouldn't take up room on the task page.

type TargetType =
  | "workspace"
  | "space"
  | "project"
  | "list"
  | "task"
  | "agent"
  | "goal"
  | "sprint";

export function AttachedPages({
  targetType,
  targetId,
  title = "Pages",
}: {
  targetType: TargetType;
  targetId: string;
  title?: string;
}) {
  const pages = useQuery(api.pages.forTarget, { targetType, targetId });
  // Resolved server-side rather than threaded down from every caller: a task
  // page shouldn't have to know how to walk up to its workspace.
  const scope = useQuery(api.pages.scopeForTarget, { targetType, targetId });
  const createPage = useMutation(api.pages.create);
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);

  if (pages === undefined || scope === undefined) return null;
  if (scope === null) return null;
  if (pages.length === 0 && !creating) {
    return (
      <button
        type="button"
        onClick={() => setCreating(true)}
        className="tap-target inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" />
        Add a page
      </button>
    );
  }

  return (
    <Card className="rounded-2xl p-5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        {!creating && (
          <button
            type="button"
            aria-label="Add a page here"
            onClick={() => setCreating(true)}
            className="tap-target inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {creating && (
        <div className="mt-3">
          <InlineCreate
            placeholder="Page title…"
            onCancel={() => setCreating(false)}
            onSubmit={async (name) => {
              try {
                await createPage({
                  scopeType: scope.scopeType,
                  scopeId: scope.scopeId,
                  title: name,
                  markdown: `# ${name}\n\n`,
                  attachTo: { targetType, targetId },
                });
                setCreating(false);
              } catch (e) {
                toast(errorMessage(e, "Couldn't create the page"), {
                  kind: "error",
                });
              }
            }}
          />
        </div>
      )}

      {pages.length > 0 && (
        <ul className="mt-3 space-y-2">
          {pages.map((p) => (
            <li key={p.pageId}>
              <Link
                href={`/dashboard/pages/${p.pageId}`}
                className="block text-sm hover:underline"
              >
                {p.title}
              </Link>
              <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                {p.excerpt || `Updated ${timeAgo(p.updatedAt)}`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
