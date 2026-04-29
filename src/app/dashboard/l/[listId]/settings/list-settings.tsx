"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";

type StatusCategory = Doc<"listStatuses">["category"];
type FieldType = Doc<"customFields">["type"];

const CATEGORY_LABEL: Record<StatusCategory, string> = {
  open: "Open",
  in_progress: "In progress",
  complete: "Complete",
  closed: "Closed",
};

const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: "Text",
  number: "Number",
  dropdown: "Dropdown",
  date: "Date",
  checkbox: "Checkbox",
};

export function ListSettings({ listId }: { listId: string }) {
  const id = listId as Id<"lists">;
  const list = useQuery(api.lists.get, { listId: id });
  const statuses = useQuery(api.listStatuses.listForList, { listId: id });
  const fields = useQuery(api.customFields.listForList, { listId: id });

  if (list === undefined || statuses === undefined || fields === undefined) {
    return <div className="h-8 w-1/3 animate-pulse rounded-full bg-muted" />;
  }
  if (list === null) {
    return (
      <div className="rounded-3xl border border-border bg-muted/30 p-10 text-center text-sm text-muted-foreground">
        List not found.
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <Link
        href={`/dashboard/l/${list._id}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> {list.name}
      </Link>

      <header>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          List settings
        </h1>
      </header>

      <StatusesSection listId={list._id} statuses={statuses} />
      <FieldsSection listId={list._id} fields={fields} />
    </div>
  );
}

function StatusesSection({
  listId,
  statuses,
}: {
  listId: Id<"lists">;
  statuses: Doc<"listStatuses">[];
}) {
  const create = useMutation(api.listStatuses.create);
  const update = useMutation(api.listStatuses.update);
  const remove = useMutation(api.listStatuses.remove);

  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Statuses
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Configure the workflow stages tasks in this list move through.
      </p>

      <ul className="mt-4 space-y-2">
        {statuses.map((status) => (
          <StatusRow
            key={status._id}
            status={status}
            otherStatuses={statuses.filter((s) => s._id !== status._id)}
            onRename={(name) => update({ statusId: status._id, name })}
            onColorChange={(color) =>
              update({ statusId: status._id, color })
            }
            onCategoryChange={(category) =>
              update({ statusId: status._id, category })
            }
            onDelete={(replaceWithId) =>
              remove({ statusId: status._id, replaceWithId })
            }
          />
        ))}
      </ul>

      <CreateStatusForm
        onSubmit={(name, color, category) =>
          create({ listId, name, color, category })
        }
      />
    </section>
  );
}

function StatusRow({
  status,
  otherStatuses,
  onRename,
  onColorChange,
  onCategoryChange,
  onDelete,
}: {
  status: Doc<"listStatuses">;
  otherStatuses: Doc<"listStatuses">[];
  onRename: (name: string) => Promise<unknown>;
  onColorChange: (color: string) => Promise<unknown>;
  onCategoryChange: (category: StatusCategory) => Promise<unknown>;
  onDelete: (replaceWithId: Id<"listStatuses">) => Promise<unknown>;
}) {
  const [name, setName] = useState(status.name);
  const [showDelete, setShowDelete] = useState(false);
  const [replaceWith, setReplaceWith] = useState<Id<"listStatuses"> | "">("");

  return (
    <li className="rounded-3xl border border-border bg-background p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="color"
          aria-label="Status color"
          value={status.color}
          onChange={(e) => onColorChange(e.currentTarget.value)}
          className="h-8 w-8 cursor-pointer rounded-full border border-border"
        />
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          onBlur={() => {
            if (name.trim() && name !== status.name) onRename(name.trim());
            else if (!name.trim()) setName(status.name);
          }}
          className="flex-1 rounded-full border border-border bg-background px-3 py-1.5 text-sm"
        />
        <select
          value={status.category}
          onChange={(e) =>
            onCategoryChange(e.currentTarget.value as StatusCategory)
          }
          className="rounded-full border border-border bg-background px-3 py-1.5 text-xs"
        >
          {(Object.keys(CATEGORY_LABEL) as StatusCategory[]).map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label="Delete status"
          onClick={() => setShowDelete((v) => !v)}
          disabled={otherStatuses.length === 0}
          title={
            otherStatuses.length === 0
              ? "Add another status before deleting this one"
              : "Delete"
          }
          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      {showDelete && (
        <div className="mt-3 rounded-2xl bg-muted p-3">
          <p className="text-xs text-muted-foreground">
            Tasks currently in <strong>{status.name}</strong> will be moved to:
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <select
              value={replaceWith}
              onChange={(e) =>
                setReplaceWith(
                  (e.currentTarget.value as Id<"listStatuses">) || "",
                )
              }
              className="flex-1 rounded-full border border-border bg-background px-3 py-1.5 text-sm"
            >
              <option value="">Pick a replacement…</option>
              {otherStatuses.map((s) => (
                <option key={s._id} value={s._id}>
                  {s.name}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="primary"
              disabled={!replaceWith}
              onClick={async () => {
                if (replaceWith) {
                  await onDelete(replaceWith);
                  setShowDelete(false);
                }
              }}
            >
              Delete
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowDelete(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

function CreateStatusForm({
  onSubmit,
}: {
  onSubmit: (
    name: string,
    color: string,
    category: StatusCategory,
  ) => Promise<unknown>;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("#6366f1");
  const [category, setCategory] = useState<StatusCategory>("open");
  const [pending, setPending] = useState(false);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        setPending(true);
        try {
          await onSubmit(name.trim(), color, category);
          setName("");
        } finally {
          setPending(false);
        }
      }}
      className="mt-3 flex flex-col gap-2 rounded-3xl border border-dashed border-border p-3 sm:flex-row sm:items-center"
    >
      <input
        type="color"
        value={color}
        onChange={(e) => setColor(e.currentTarget.value)}
        className="h-8 w-8 cursor-pointer rounded-full border border-border"
        aria-label="New status color"
      />
      <input
        type="text"
        placeholder="New status name"
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        className="flex-1 rounded-full border border-border bg-background px-3 py-1.5 text-sm"
      />
      <select
        value={category}
        onChange={(e) => setCategory(e.currentTarget.value as StatusCategory)}
        className="rounded-full border border-border bg-background px-3 py-1.5 text-xs"
      >
        {(Object.keys(CATEGORY_LABEL) as StatusCategory[]).map((c) => (
          <option key={c} value={c}>
            {CATEGORY_LABEL[c]}
          </option>
        ))}
      </select>
      <Button type="submit" size="sm" disabled={!name.trim() || pending}>
        <Plus className="h-4 w-4" /> Add
      </Button>
    </form>
  );
}

function FieldsSection({
  listId,
  fields,
}: {
  listId: Id<"lists">;
  fields: Doc<"customFields">[];
}) {
  const create = useMutation(api.customFields.create);
  const rename = useMutation(api.customFields.rename);
  const updateOptions = useMutation(api.customFields.updateOptions);
  const remove = useMutation(api.customFields.remove);

  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Custom fields
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Add columns to track per-task data beyond the defaults.
      </p>

      <ul className="mt-4 space-y-2">
        {fields.length === 0 && (
          <li className="rounded-3xl border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
            No custom fields yet.
          </li>
        )}
        {fields.map((field) => (
          <FieldRow
            key={field._id}
            field={field}
            onRename={(name) => rename({ fieldId: field._id, name })}
            onUpdateOptions={(options) =>
              updateOptions({ fieldId: field._id, options })
            }
            onDelete={() => remove({ fieldId: field._id })}
          />
        ))}
      </ul>

      <CreateFieldForm
        onSubmit={(name, type, options) =>
          create({ listId, name, type, options })
        }
      />
    </section>
  );
}

function FieldRow({
  field,
  onRename,
  onUpdateOptions,
  onDelete,
}: {
  field: Doc<"customFields">;
  onRename: (name: string) => Promise<unknown>;
  onUpdateOptions: (
    options: { id: string; label: string; color?: string }[],
  ) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
}) {
  const [name, setName] = useState(field.name);
  const [showOptions, setShowOptions] = useState(false);

  return (
    <li className="rounded-3xl border border-border bg-background p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <span className="rounded-full bg-muted px-2.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          {FIELD_TYPE_LABEL[field.type]}
        </span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          onBlur={() => {
            if (name.trim() && name !== field.name) onRename(name.trim());
            else if (!name.trim()) setName(field.name);
          }}
          className="flex-1 rounded-full border border-border bg-background px-3 py-1.5 text-sm"
        />
        {field.type === "dropdown" && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setShowOptions((v) => !v)}
          >
            Options ({field.options?.length ?? 0})
          </Button>
        )}
        <button
          type="button"
          aria-label="Delete field"
          onClick={() => {
            if (
              window.confirm(
                `Delete "${field.name}" and all its values across every task?`,
              )
            ) {
              onDelete();
            }
          }}
          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      {field.type === "dropdown" && showOptions && (
        <DropdownOptionsEditor
          options={field.options ?? []}
          onChange={onUpdateOptions}
        />
      )}
    </li>
  );
}

function DropdownOptionsEditor({
  options,
  onChange,
}: {
  options: { id: string; label: string; color?: string }[];
  onChange: (
    options: { id: string; label: string; color?: string }[],
  ) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState("");
  const [color, setColor] = useState("#6366f1");

  return (
    <div className="mt-3 rounded-2xl bg-muted p-3">
      <ul className="space-y-1">
        {options.map((opt, i) => (
          <li
            key={opt.id}
            className="flex items-center gap-2 rounded-full bg-background px-3 py-1 text-sm"
          >
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: opt.color ?? "#a1a1aa" }}
            />
            <span className="flex-1">{opt.label}</span>
            <button
              type="button"
              onClick={() =>
                onChange(options.filter((_, idx) => idx !== i))
              }
              className="text-xs text-muted-foreground hover:text-foreground"
              aria-label={`Remove ${opt.label}`}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex items-center gap-2">
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.currentTarget.value)}
          className="h-7 w-7 cursor-pointer rounded-full border border-border"
          aria-label="Option color"
        />
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          placeholder="New option"
          className="flex-1 rounded-full border border-border bg-background px-3 py-1 text-sm"
        />
        <Button
          type="button"
          size="sm"
          disabled={!draft.trim()}
          onClick={async () => {
            await onChange([
              ...options,
              {
                id: crypto.randomUUID(),
                label: draft.trim(),
                color,
              },
            ]);
            setDraft("");
          }}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

function CreateFieldForm({
  onSubmit,
}: {
  onSubmit: (
    name: string,
    type: FieldType,
    options?: { id: string; label: string; color?: string }[],
  ) => Promise<unknown>;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const [pending, setPending] = useState(false);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        setPending(true);
        try {
          await onSubmit(
            name.trim(),
            type,
            type === "dropdown"
              ? [
                  {
                    id: crypto.randomUUID(),
                    label: "Option 1",
                    color: "#6366f1",
                  },
                ]
              : undefined,
          );
          setName("");
          setType("text");
        } finally {
          setPending(false);
        }
      }}
      className="mt-3 flex flex-col gap-2 rounded-3xl border border-dashed border-border p-3 sm:flex-row sm:items-center"
    >
      <input
        type="text"
        placeholder="New field name"
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        className="flex-1 rounded-full border border-border bg-background px-3 py-1.5 text-sm"
      />
      <select
        value={type}
        onChange={(e) => setType(e.currentTarget.value as FieldType)}
        className="rounded-full border border-border bg-background px-3 py-1.5 text-xs"
      >
        {(Object.keys(FIELD_TYPE_LABEL) as FieldType[]).map((t) => (
          <option key={t} value={t}>
            {FIELD_TYPE_LABEL[t]}
          </option>
        ))}
      </select>
      <Button type="submit" size="sm" disabled={!name.trim() || pending}>
        <Plus className="h-4 w-4" /> Add field
      </Button>
    </form>
  );
}
