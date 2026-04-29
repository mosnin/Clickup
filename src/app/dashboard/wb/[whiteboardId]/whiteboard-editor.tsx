"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

// tldraw is ~500 kB; lazy-load so other dashboard routes don't pay for it.
// `ssr: false` because tldraw needs `window`.
const TldrawCanvas = dynamic(
  () => import("./tldraw-canvas").then((m) => m.TldrawCanvas),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[70vh] items-center justify-center rounded-3xl border border-border bg-muted/40 text-sm text-muted-foreground">
        Loading whiteboard…
      </div>
    ),
  },
);

export function WhiteboardEditor({
  whiteboardId,
}: {
  whiteboardId: string;
}) {
  const id = whiteboardId as Id<"whiteboards">;
  const wb = useQuery(api.whiteboards.get, { whiteboardId: id });
  const rename = useMutation(api.whiteboards.rename);
  const remove = useMutation(api.whiteboards.remove);

  const [title, setTitle] = useState("");
  if (wb === undefined) {
    return (
      <div className="space-y-4">
        <div className="h-12 w-2/3 animate-pulse rounded-full bg-muted" />
        <div className="h-[70vh] animate-pulse rounded-3xl bg-muted/40" />
      </div>
    );
  }
  if (wb === null) {
    return (
      <div className="rounded-3xl border border-border bg-muted/30 p-10 text-center">
        <p className="text-sm text-muted-foreground">
          This whiteboard doesn&apos;t exist or you don&apos;t have access.
        </p>
        <Link
          href="/dashboard"
          className="mt-3 inline-block text-sm font-medium text-brand-600 hover:underline"
        >
          Back to dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Dashboard
        </Link>
        <button
          type="button"
          onClick={() => {
            if (window.confirm("Delete this whiteboard?")) {
              remove({ whiteboardId: id }).then(() => {
                window.history.back();
              });
            }
          }}
          className="rounded-full px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          Delete
        </button>
      </div>

      <input
        type="text"
        value={title || wb.title}
        onChange={(e) => setTitle(e.currentTarget.value)}
        onBlur={() => {
          const next = (title || wb.title).trim();
          if (next && next !== wb.title) {
            rename({ whiteboardId: id, title: next });
          } else {
            setTitle("");
          }
        }}
        placeholder="Untitled board"
        className="w-full bg-transparent text-2xl font-semibold tracking-tight focus:outline-none sm:text-3xl"
      />

      <TldrawCanvas whiteboardId={id} initialSnapshot={wb.snapshot} />
    </div>
  );
}
