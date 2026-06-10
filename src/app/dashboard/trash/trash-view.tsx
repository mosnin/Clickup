"use client";

import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import {
  CheckSquare,
  FileText,
  Folder,
  LayoutGrid,
  List as ListIcon,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/dashboard/toast";

const RETENTION_DAYS = 30;

export function Trash() {
  const items = useQuery(api.trash.listForCurrent, {});
  const restoreTask = useMutation(api.tasks.restore);
  const restoreList = useMutation(api.lists.restore);
  const restoreFolder = useMutation(api.folders.restore);
  const restoreDoc = useMutation(api.docs.restore);
  const restoreWhiteboard = useMutation(api.whiteboards.restore);
  const purgeTask = useMutation(api.tasks.purge);
  const purgeList = useMutation(api.lists.purge);
  const purgeFolder = useMutation(api.folders.purge);
  const purgeDoc = useMutation(api.docs.purge);
  const purgeWhiteboard = useMutation(api.whiteboards.purge);
  const toast = useToast();

  if (items === undefined) {
    return (
      <div className="space-y-3">
        <div className="h-8 w-1/3 animate-pulse rounded-full bg-muted" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-14 animate-pulse rounded-2xl bg-muted/40" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Trash
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Anything you delete lands here for {RETENTION_DAYS} days, then it&apos;s gone for good.
        </p>
      </header>

      {items.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-border bg-muted/30 p-10 text-center text-sm text-muted-foreground">
          Trash is empty. When you delete a task, list, doc, or whiteboard, it
          shows up here with a 5-second{" "}
          <kbd className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px]">
            Undo
          </kbd>
          .
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => {
            const days = Math.max(
              0,
              Math.floor(
                (item.deletedAt + RETENTION_DAYS * 86_400_000 - Date.now()) /
                  86_400_000,
              ),
            );
            const Icon = ICON_FOR_KIND[item.kind];
            const restoreOne = async () => {
              if (item.kind === "task") {
                await restoreTask({ taskId: item.id as Id<"tasks"> });
              } else if (item.kind === "list") {
                await restoreList({ listId: item.id as Id<"lists"> });
              } else if (item.kind === "folder") {
                await restoreFolder({ folderId: item.id as Id<"folders"> });
              } else if (item.kind === "doc") {
                await restoreDoc({ docId: item.id as Id<"docs"> });
              } else {
                await restoreWhiteboard({
                  whiteboardId: item.id as Id<"whiteboards">,
                });
              }
              toast.show({ label: `Restored "${item.title}"` });
            };
            const purgeOne = async () => {
              if (
                !window.confirm(
                  `Permanently delete "${item.title}"? This can't be undone.`,
                )
              ) {
                return;
              }
              if (item.kind === "task") {
                await purgeTask({ taskId: item.id as Id<"tasks"> });
              } else if (item.kind === "list") {
                await purgeList({ listId: item.id as Id<"lists"> });
              } else if (item.kind === "folder") {
                await purgeFolder({ folderId: item.id as Id<"folders"> });
              } else if (item.kind === "doc") {
                await purgeDoc({ docId: item.id as Id<"docs"> });
              } else {
                await purgeWhiteboard({
                  whiteboardId: item.id as Id<"whiteboards">,
                });
              }
            };

            return (
              <li
                key={`${item.kind}:${item.id}`}
                className="flex items-center gap-3 rounded-3xl border border-border bg-background p-3"
              >
                <Icon
                  className="h-4 w-4 flex-shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{item.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {item.kind} · {days} day{days === 1 ? "" : "s"} left
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={restoreOne}
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Restore
                </Button>
                <button
                  type="button"
                  aria-label={`Permanently delete ${item.title}`}
                  onClick={purgeOne}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const ICON_FOR_KIND = {
  task: CheckSquare,
  list: ListIcon,
  folder: Folder,
  doc: FileText,
  whiteboard: LayoutGrid,
} as const;

// Source the link so the kbd-ish `RETENTION_DAYS` is referenced —
// avoids the no-unused-vars lint when retention messaging is the only
// place it shows up.
void Link;
