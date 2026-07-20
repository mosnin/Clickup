"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "convex/react";
import { X } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Lightweight modal — no Radix dependency. Backdrop click + Esc close.
type ParentSpec =
  | { kind: "space"; spaceId: Id<"spaces"> }
  | { kind: "folder"; folderId: Id<"folders"> };

// `templates.list` only returns id/name/emoji/description today. If it ever
// grows richer counts (statuses/fields/sample tasks), surface them here as
// the quiet meta line — until then the line simply doesn't render.
type TemplateMeta = {
  id: string;
  name: string;
  description: string;
  statusCount?: number;
  fieldCount?: number;
  hasSampleTasks?: boolean;
};

function metaLine(t: TemplateMeta): string | null {
  const parts: string[] = [];
  if (t.statusCount) parts.push(`${t.statusCount} statuses`);
  if (t.fieldCount) parts.push(`${t.fieldCount} fields`);
  if (t.hasSampleTasks) parts.push("sample tasks");
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function TemplatePicker({
  open,
  parent,
  onClose,
  onCreated,
}: {
  open: boolean;
  parent: ParentSpec | null;
  onClose: () => void;
  onCreated: (listId: Id<"lists">) => void;
}) {
  const templates = useQuery(api.templates.list, open ? {} : "skip");
  const apply = useMutation(api.templates.applyListTemplate);

  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!open) {
      setSelected(null);
      setName("");
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !parent || typeof document === "undefined") return null;

  const chosen = templates?.find((t) => t.id === selected) ?? null;

  // Portaled to <body>: this dialog is opened from inside the sidebar,
  // whose collapse animation puts a CSS transform on the <aside>. A
  // transformed ancestor becomes the containing block for position:fixed,
  // which would trap the "fullscreen" overlay inside the sidebar box.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Start from a template"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <div
        aria-hidden
        onClick={onClose}
        className="absolute inset-0 bg-foreground/40 backdrop-blur-sm"
      />
      <div className="bento relative flex w-full max-w-2xl flex-col rounded-2xl p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Start from a template</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Seeds a list with statuses, custom fields, and a few sample tasks.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="tap-target inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {templates === undefined && (
            <p className="col-span-full text-sm text-muted-foreground">Loading templates…</p>
          )}
          {templates?.map((t) => {
            const meta = metaLine(t);
            const isSelected = selected === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setSelected(t.id);
                  if (!name) setName(t.name);
                }}
                aria-pressed={isSelected}
                className={cn(
                  "lift rounded-2xl p-4 text-left transition-colors",
                  isSelected
                    ? "bento ring-2 ring-foreground/15"
                    : "bento-tile hover:bg-border/40",
                )}
              >
                <span className="block font-medium">{t.name}</span>
                <p className="mt-1.5 line-clamp-2 text-sm text-muted-foreground">
                  {t.description}
                </p>
                {meta && (
                  <span className="mt-2 block text-xs text-muted-foreground">{meta}</span>
                )}
              </button>
            );
          })}
        </div>

        <div className="mt-6">
          <label className="block text-xs font-medium text-muted-foreground">
            List name
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder={chosen?.name ?? "New list"}
              className="soft-field mt-1.5 w-full px-3.5 py-2.5 text-sm"
            />
          </label>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!chosen || !name.trim() || pending}
            onClick={async () => {
              if (!chosen) return;
              setPending(true);
              try {
                const listId = await apply({
                  templateId: chosen.id,
                  name: name.trim() || chosen.name,
                  parentType: parent.kind,
                  parentId: parent.kind === "space" ? parent.spaceId : parent.folderId,
                });
                onCreated(listId);
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? "Creating…" : "Use template"}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
