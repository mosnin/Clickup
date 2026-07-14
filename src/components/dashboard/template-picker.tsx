"use client";

import { useEffect, useState } from "react";
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

  if (!open || !parent) return null;

  const chosen = templates?.find((t) => t.id === selected) ?? null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <div
        aria-hidden
        onClick={onClose}
        className="absolute inset-0 bg-foreground/40 backdrop-blur-sm"
      />
      <div className="relative w-full max-w-2xl rounded-2xl border border-border bg-background shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold">Pick a list template</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid gap-2 p-5 sm:grid-cols-2">
          {templates === undefined && (
            <p className="col-span-full text-sm text-muted-foreground">
              Loading templates…
            </p>
          )}
          {templates?.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setSelected(t.id);
                if (!name) setName(t.name);
              }}
              className={cn(
                "rounded-2xl border p-4 text-left transition-colors",
                selected === t.id
                  ? "border-brand-500 bg-brand-50/50"
                  : "border-border bg-background hover:border-foreground/25",
              )}
            >
              <div className="flex items-baseline gap-2">
                <span aria-hidden className="text-base">
                  {t.emoji}
                </span>
                <span className="font-medium">{t.name}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {t.description}
              </p>
            </button>
          ))}
        </div>

        <div className="border-t border-border px-5 py-3">
          <label className="block text-xs text-muted-foreground">
            List name
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder={chosen?.name ?? "New list"}
              className="mt-1 w-full rounded-full border border-border bg-background px-3 py-1.5 text-sm"
            />
          </label>
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
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
                  parentId:
                    parent.kind === "space" ? parent.spaceId : parent.folderId,
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
    </div>
  );
}
