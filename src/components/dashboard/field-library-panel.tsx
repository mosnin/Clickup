"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Plus, Trash2 } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Picker } from "@/components/ui/picker";
import { useToast } from "@/components/toast";
import { cn } from "@/lib/utils";
import { AnimatePresence, EASE, motion } from "@/components/motion";

// Workspace field library: define a custom field once here, then stamp it
// onto any project ("Apply to project…"). Applying copies the definition
// into that list's own customFields row, so per-list behavior downstream
// is unchanged — deleting a library field never touches the copies.
//
// Self-contained: mount from the workspace Settings tab as
// <FieldLibraryPanel workspaceId={workspaceId} />.

type LibraryField = Doc<"fieldLibrary">;
type FieldType = LibraryField["type"];

const TYPE_LABEL: Record<FieldType, string> = {
  text: "Text",
  number: "Number",
  dropdown: "Dropdown",
  date: "Date",
  checkbox: "Checkbox",
};

const TYPE_OPTIONS = (Object.keys(TYPE_LABEL) as FieldType[]).map((t) => ({
  id: t,
  label: TYPE_LABEL[t],
}));

function errorMessage(e: unknown, fallback: string): string {
  const raw = e instanceof Error ? e.message : String(e);
  return (
    raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() || fallback
  );
}

export function FieldLibraryPanel({
  workspaceId,
}: {
  workspaceId: Id<"workspaces">;
}) {
  const fields = useQuery(api.fieldLibrary.listForWorkspace, { workspaceId });
  // The sidebar tree is already subscribed app-wide — free source for the
  // "Apply to project…" picker.
  const tree = useQuery(api.sidebar.tree, {});
  const create = useMutation(api.fieldLibrary.create);
  const remove = useMutation(api.fieldLibrary.remove);
  const applyToList = useMutation(api.fieldLibrary.applyToList);
  const { toast } = useToast();

  const [creating, setCreating] = useState(false);
  // Hidden while their undo toasts are live — deletes commit on expiry.
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());

  const projects = useMemo(() => {
    const ws = tree?.workspaces.find((w) => w._id === workspaceId);
    if (!ws) return [];
    const rows: { id: string; label: string; hint?: string }[] = [];
    for (const sp of ws.spaces) {
      for (const l of [...sp.lists, ...sp.folders.flatMap((f) => f.lists)]) {
        rows.push({ id: l._id as string, label: l.name, hint: sp.name });
      }
    }
    return rows;
  }, [tree, workspaceId]);

  function deleteField(field: LibraryField) {
    const unhide = () =>
      setHiddenIds((prev) => {
        const next = new Set(prev);
        next.delete(field._id);
        return next;
      });
    setHiddenIds((prev) => new Set(prev).add(field._id));
    toast(`"${field.name}" removed — projects keep their copies`, {
      action: { label: "Undo", onClick: unhide },
      onExpire: () =>
        void remove({ fieldId: field._id }).catch((e) => {
          // Failed commit: un-hide so the still-existing field reappears.
          unhide();
          toast(errorMessage(e, "Couldn't delete field"), { kind: "error" });
        }),
    });
  }

  function apply(field: LibraryField, listId: string) {
    const project = projects.find((p) => p.id === listId);
    void applyToList({
      fieldId: field._id,
      listId: listId as Id<"lists">,
    }).then(
      () =>
        toast(
          `"${field.name}" added to ${project?.label ?? "the project"}`,
        ),
      (e: unknown) =>
        toast(errorMessage(e, "Couldn't apply field"), { kind: "error" }),
    );
  }

  if (fields === undefined) {
    return (
      <section className="rounded-2xl panel p-4 sm:p-5">
        <div className="h-5 w-32 animate-pulse rounded-full bg-muted/40" />
        <div className="mt-3 space-y-2">
          {[0, 1].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-xl bg-muted/30" />
          ))}
        </div>
      </section>
    );
  }

  const visible = fields.filter((f) => !hiddenIds.has(f._id));

  return (
    <section className="rounded-2xl panel p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Field library</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Define a field once, apply it to any project in this workspace.
          </p>
        </div>
        {!creating && (
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" /> New field
          </Button>
        )}
      </div>

      {creating && (
        <CreateFieldForm
          onCancel={() => setCreating(false)}
          onSubmit={async (name, type, options) => {
            try {
              await create({ workspaceId, name, type, options });
              setCreating(false);
              toast(`"${name}" added to the library`);
            } catch (e) {
              toast(errorMessage(e, "Couldn't create field"), {
                kind: "error",
              });
            }
          }}
        />
      )}

      {visible.length === 0 && !creating ? (
        <p className="mt-3 text-sm text-muted-foreground">
          No library fields yet. Create one and stamp it onto any project —
          no more redefining &quot;Priority&quot; list by list.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          <AnimatePresence initial={false}>
            {visible.map((field) => (
              <motion.li
                key={field._id}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97 }}
                transition={{ duration: 0.25, ease: EASE }}
                className="bento-tile flex flex-wrap items-center gap-x-2 gap-y-1.5 p-3"
              >
                <span
                  className="min-w-0 flex-1 truncate text-sm font-medium"
                  title={field.name}
                >
                  {field.name}
                </span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                  {TYPE_LABEL[field.type]}
                </span>
                {field.type === "dropdown" && (
                  <span className="text-xs text-muted-foreground">
                    {field.options?.length ?? 0} option
                    {(field.options?.length ?? 0) === 1 ? "" : "s"}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-1">
                  <Picker
                    label="Apply to project…"
                    dashed
                    options={projects}
                    onSelect={(listId) => apply(field, listId)}
                  />
                  <button
                    type="button"
                    aria-label={`Delete ${field.name}`}
                    onClick={() => deleteField(field)}
                    className="tap-target inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-red-600"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </section>
  );
}

// In-place create form: Enter in the name creates (like InlineCreate),
// Escape cancels. A plain input rather than <InlineCreate> because the
// dropdown variant needs a second control (the options textarea) and
// InlineCreate's blur-empty-cancel would close the form on the way there.
function CreateFieldForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (
    name: string,
    type: FieldType,
    options?: { id: string; label: string }[],
  ) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const [optionsText, setOptionsText] = useState("");
  const [pending, setPending] = useState(false);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    const options =
      type === "dropdown"
        ? optionsText
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((label) => ({ id: crypto.randomUUID(), label }))
        : undefined;
    setPending(true);
    try {
      await onSubmit(trimmed, type, options);
    } finally {
      setPending(false);
    }
  }

  return (
    <motion.form
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: EASE }}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="bento-tile mt-3 space-y-2 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Picker
          label={TYPE_LABEL[type]}
          selectedId={type}
          options={TYPE_OPTIONS}
          onSelect={(id) => setType(id as FieldType)}
        />
        <input
          autoFocus
          value={name}
          disabled={pending}
          onChange={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          placeholder="Field name…"
          className="soft-field min-w-0 flex-1 px-3 py-1.5 text-sm disabled:opacity-60"
        />
      </div>
      {type === "dropdown" && (
        <label className="block">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Options — one per line
          </span>
          <textarea
            value={optionsText}
            disabled={pending}
            onChange={(e) => setOptionsText(e.currentTarget.value)}
            rows={3}
            placeholder={"High\nMedium\nLow"}
            className="soft-field w-full px-3 py-2 text-sm disabled:opacity-60"
          />
        </label>
      )}
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={
            !name.trim() ||
            pending ||
            (type === "dropdown" && !optionsText.trim())
          }
        >
          {pending ? "Adding…" : "Add field"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onCancel}
          className={cn(pending && "pointer-events-none opacity-60")}
        >
          Cancel
        </Button>
      </div>
    </motion.form>
  );
}
