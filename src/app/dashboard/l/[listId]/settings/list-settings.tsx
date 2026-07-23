"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/toast";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft, Check, Copy, Plus, Settings, Trash2, X } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Picker } from "@/components/ui/picker";
import { PageHeader } from "@/components/dashboard/page-header";
import { ScheduledTasksSection } from "@/components/dashboard/scheduled-tasks-section";
import { useListScope } from "../use-list-scope";

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

// Shared shape for a "row list inside a Card" section — a bordered
// container with divided rows, plus a distinct dashed-border row at the
// bottom for creating a new entry. Keeps Statuses/Fields/Automations/Forms
// visually consistent without duplicating the wrapper markup.
function RowList({ children }: { children: React.ReactNode }) {
  return (
    <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
      {children}
    </div>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-4 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function errorMessage(e: unknown, fallback: string): string {
  const raw = e instanceof Error ? e.message : String(e);
  return (
    raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() || fallback
  );
}

export function ListSettings({ listId }: { listId: string }) {
  const id = listId as Id<"lists">;
  const list = useQuery(api.lists.get, { listId: id });
  const statuses = useQuery(api.listStatuses.listForList, { listId: id });
  const fields = useQuery(api.customFields.listForList, { listId: id });
  const automations = useQuery(api.listAutomations.listForList, {
    listId: id,
  });

  if (
    list === undefined ||
    statuses === undefined ||
    fields === undefined ||
    automations === undefined
  ) {
    return <div className="h-8 w-1/3 animate-pulse rounded-full bg-muted" />;
  }
  if (list === null) {
    return (
      <div className="rounded-2xl border border-border bg-muted/30 p-10 text-center text-sm text-muted-foreground">
        List not found.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link
        href={`/dashboard/l/${list._id}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> {list.name}
      </Link>

      <PageHeader
        icon={Settings}
        title={`${list.name} settings`}
        context={
          <span className="truncate">
            Operations, statuses, custom fields, automations, and schedules
          </span>
        }
      />

      <IdentityCard listId={list._id} list={list} />
      <OperationsSection listId={list._id} list={list} />
      <StatusesSection listId={list._id} statuses={statuses} />
      <FieldsSection listId={list._id} fields={fields} />
      <AutomationsSection
        listId={list._id}
        automations={automations}
        statuses={statuses}
      />
      <Card className="rounded-2xl">
        <CardContent>
          <ScheduledTasksSection listId={list._id} />
        </CardContent>
      </Card>
      <FormsSection listId={list._id} />
      <DangerCard list={list} />
    </div>
  );
}

// Rename in place — the only list-identity control missing from this page
// before now (name showed up everywhere but could only ever be set once,
// at creation).
function IdentityCard({
  listId,
  list,
}: {
  listId: Id<"lists">;
  list: Doc<"lists">;
}) {
  const rename = useMutation(api.lists.rename);
  const { toast } = useToast();
  const [name, setName] = useState(list.name);

  useEffect(() => setName(list.name), [list.name]);

  async function commit() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === list.name) {
      setName(list.name);
      return;
    }
    try {
      await rename({ listId, name: trimmed });
      toast("Saved");
    } catch (e) {
      setName(list.name);
      toast(errorMessage(e, "Couldn't rename the list"), { kind: "error" });
    }
  }

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle>Identity</CardTitle>
        <CardDescription>Rename this list.</CardDescription>
      </CardHeader>
      <CardContent>
        <label className="block text-xs font-medium text-muted-foreground">
          Name
          <Input
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                (e.currentTarget as HTMLInputElement).blur();
              } else if (e.key === "Escape") {
                setName(list.name);
              }
            }}
            className="mt-1.5"
          />
        </label>
      </CardContent>
    </Card>
  );
}

type RoutingMode = NonNullable<Doc<"lists">["routing"]>["mode"];
type DefaultView = NonNullable<Doc<"lists">["defaultView"]>;

const ROUTING_MODES: { key: "off" | RoutingMode; label: string }[] = [
  { key: "off", label: "Off" },
  { key: "fixed", label: "Fixed" },
  { key: "round_robin", label: "Round robin" },
  { key: "least_loaded", label: "Least loaded" },
];

const DEFAULT_VIEW_OPTIONS: { key: "default" | DefaultView; label: string }[] =
  [
    { key: "default", label: "Default" },
    { key: "list", label: "List" },
    { key: "board", label: "Board" },
    { key: "calendar", label: "Calendar" },
    { key: "gantt", label: "Gantt" },
    { key: "table", label: "Table" },
    { key: "workload", label: "Workload" },
  ];

// Per-project operations config (Phase L): assignment routing, an attached
// SOP playbook, and the view this project opens in by default.
function OperationsSection({
  listId,
  list,
}: {
  listId: Id<"lists">;
  list: Doc<"lists">;
}) {
  const setRouting = useMutation(api.lists.setRouting);
  const updateMeta = useMutation(api.lists.updateMeta);
  // Same people+agents source as the task assignee picker, so routing can
  // target anyone assignable in this list.
  const assignable = useQuery(api.agents.listAssignableForList, { listId });
  const scope = useListScope(listId);
  const skills = useQuery(api.skills.listForScope, scope ?? "skip");
  const { toast } = useToast();

  const [mode, setMode] = useState<"off" | RoutingMode>(
    list.routing?.mode ?? "off",
  );
  const [assigneeIds, setAssigneeIds] = useState<string[]>(
    list.routing?.assigneeIds ?? [],
  );
  useEffect(() => {
    setMode(list.routing?.mode ?? "off");
    setAssigneeIds(list.routing?.assigneeIds ?? []);
  }, [list.routing]);

  // Save on every change. A mode with no assignees yet isn't saveable
  // (the server refuses an empty rotation) — hold it locally and hint.
  async function commitRouting(
    nextMode: "off" | RoutingMode,
    nextIds: string[],
  ) {
    setMode(nextMode);
    setAssigneeIds(nextIds);
    try {
      if (nextMode === "off") {
        if (list.routing) {
          await setRouting({ listId, routing: null });
          toast("Saved");
        }
      } else if (nextIds.length > 0) {
        await setRouting({
          listId,
          routing: { mode: nextMode, assigneeIds: nextIds },
        });
        toast("Saved");
      } else if (list.routing) {
        // Removing the last assignee leaves nothing to route to — clear
        // the stored rule rather than leaving it dangling server-side.
        await setRouting({ listId, routing: null });
        toast("Saved");
      }
    } catch (e) {
      setMode(list.routing?.mode ?? "off");
      setAssigneeIds(list.routing?.assigneeIds ?? []);
      toast(errorMessage(e, "Couldn't save the routing rule"), {
        kind: "error",
      });
    }
  }

  async function commitMeta(
    patch: { sopSlug: string | null } | { defaultView: DefaultView | null },
    fallback: string,
  ) {
    try {
      await updateMeta({ listId, ...patch });
      toast("Saved");
    } catch (e) {
      toast(errorMessage(e, fallback), { kind: "error" });
    }
  }

  const nameFor = (id: string) =>
    (assignable ?? []).find((a) => a.id === id)?.name ?? "Unknown";
  const remaining = (assignable ?? []).filter(
    (a) => !assigneeIds.includes(a.id),
  );
  const enabledSkills = (skills ?? []).filter((s) => s.enabled);
  const currentSkill = list.sopSlug
    ? (skills ?? []).find((s) => s.slug === list.sopSlug)
    : undefined;

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle>Operations</CardTitle>
        <CardDescription>
          Route new tasks to the right people, attach a playbook, and pick the
          view this project opens in.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div>
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Assignment routing
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            {ROUTING_MODES.map((m) => {
              const on = mode === m.key;
              return (
                <button
                  key={m.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    // Re-clicking the active mode would reset the rotation
                    // cursor server-side for nothing — skip it.
                    if (!on) commitRouting(m.key, assigneeIds);
                  }}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    on
                      ? "border-transparent bg-foreground text-background"
                      : "border-border bg-background text-muted-foreground hover:text-foreground",
                  )}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
          {mode !== "off" && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {assigneeIds.map((id) => (
                <span
                  key={id}
                  className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium"
                >
                  {nameFor(id)}
                  <button
                    type="button"
                    aria-label={`Remove ${nameFor(id)} from routing`}
                    onClick={() =>
                      commitRouting(
                        mode,
                        assigneeIds.filter((a) => a !== id),
                      )
                    }
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              {remaining.length > 0 && (
                <Picker
                  dashed
                  label="Add assignee…"
                  options={remaining.map((a) => ({
                    id: a.id,
                    label: a.name,
                    hint: a.kind === "agent" ? "agent" : undefined,
                  }))}
                  onSelect={(id) => commitRouting(mode, [...assigneeIds, id])}
                />
              )}
              {assigneeIds.length === 0 && (
                <span className="text-xs text-muted-foreground">
                  Pick at least one assignee to turn the rule on.
                </span>
              )}
            </div>
          )}
          <p className="mt-1.5 text-xs text-muted-foreground">
            Tasks created without an assignee get one automatically — explicit
            assignees always win.
          </p>
        </div>

        <div>
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            SOP
          </span>
          {list.sopSlug ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium">
              {currentSkill?.name ?? list.sopSlug}
              <button
                type="button"
                aria-label="Detach SOP"
                onClick={() =>
                  commitMeta({ sopSlug: null }, "Couldn't detach the SOP")
                }
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ) : (
            <Picker
              dashed
              label="Attach an SOP…"
              options={enabledSkills.map((s) => ({
                id: s.slug,
                label: s.name,
                hint: s.builtin ? "built-in" : undefined,
              }))}
              onSelect={(slug) =>
                commitMeta({ sopSlug: slug }, "Couldn't attach the SOP")
              }
            />
          )}
          <p className="mt-1.5 text-xs text-muted-foreground">
            Agents receive this playbook with every task they read from this
            project.
          </p>
        </div>

        <div>
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Default view
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            {DEFAULT_VIEW_OPTIONS.map((opt) => {
              const on =
                opt.key === "default"
                  ? list.defaultView === undefined
                  : list.defaultView === opt.key;
              return (
                <button
                  key={opt.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    commitMeta(
                      {
                        defaultView: opt.key === "default" ? null : opt.key,
                      },
                      "Couldn't set the default view",
                    )
                  }
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    on
                      ? "border-transparent bg-foreground text-background"
                      : "border-border bg-background text-muted-foreground hover:text-foreground",
                  )}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            The view this project opens in when a link doesn&apos;t specify
            one.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// Permanent, cascading delete (convex/lists.ts `remove` — tasks, statuses,
// fields, automations, schedules all go with it). No native `window.confirm`:
// an explicit two-step reveal stands in for it, then the same undo-able
// deferred-commit pattern used for every other destructive action here
// (hide/route away immediately, commit only once the toast's Undo window
// closes) — except there's no row to "hide", so we navigate away right away
// and only run the mutation if the undo window elapses.
function DangerCard({ list }: { list: Doc<"lists"> }) {
  const router = useRouter();
  const remove = useMutation(api.lists.remove);
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);

  // We only have enough context client-side to resolve straight back to a
  // Space (parentId IS the spaceId); a folder-parented list has no folder
  // page to land on yet, so fall back to the dashboard root.
  const destination =
    list.parentType === "space"
      ? `/dashboard/s/${list.parentId}`
      : "/dashboard";

  function confirmDelete() {
    setConfirming(false);
    router.push(destination);
    toast(`"${list.name}" deleted — its tasks, docs, and history go with it`, {
      action: {
        label: "Undo",
        onClick: () => toast(`"${list.name}" restored`),
      },
      onExpire: () => {
        remove({ listId: list._id }).catch(() => {
          toast("Couldn't delete the list", { kind: "error" });
        });
      },
    });
  }

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle>Danger zone</CardTitle>
        <CardDescription>
          Permanently delete this list and everything in it — tasks,
          comments, docs, and schedules. This can&apos;t be undone once the
          undo window below closes.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {confirming ? (
          <div className="rounded-xl bg-muted p-3">
            <p className="text-sm text-muted-foreground">
              Delete <strong>{list.name}</strong> and all of its tasks?
            </p>
            <div className="mt-2 flex gap-2">
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={confirmDelete}
              >
                Delete list
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setConfirming(true)}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" /> Delete list
          </Button>
        )}
      </CardContent>
    </Card>
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
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle>Statuses</CardTitle>
        <CardDescription>
          Configure the workflow stages tasks in this list move through.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <RowList>
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
        </RowList>

        <CreateStatusForm
          onSubmit={(name, color, category) =>
            create({ listId, name, color, category })
          }
        />
      </CardContent>
    </Card>
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
    <div className="p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {/* Native color input: no vendored equivalent, keep the OS color
            picker's mechanics as-is. */}
        <input
          type="color"
          aria-label="Status color"
          value={status.color}
          onChange={(e) => onColorChange(e.currentTarget.value)}
          className="h-8 w-8 flex-shrink-0 cursor-pointer rounded-full border border-border"
        />
        <Input
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          onBlur={() => {
            if (name.trim() && name !== status.name) onRename(name.trim());
            else if (!name.trim()) setName(status.name);
          }}
          className="flex-1"
        />
        <Select
          value={status.category}
          onValueChange={(v) => onCategoryChange(v as StatusCategory)}
        >
          <SelectTrigger size="sm" className="w-36 flex-shrink-0 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(CATEGORY_LABEL) as StatusCategory[]).map((c) => (
              <SelectItem key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Delete status"
          onClick={() => setShowDelete((v) => !v)}
          disabled={otherStatuses.length === 0}
          title={
            otherStatuses.length === 0
              ? "Add another status before deleting this one"
              : "Delete"
          }
          className="tap-target flex-shrink-0 text-muted-foreground hover:text-foreground"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {showDelete && (
        <div className="mt-3 rounded-xl bg-muted p-3">
          <p className="text-xs text-muted-foreground">
            Tasks currently in <strong>{status.name}</strong> will be moved to:
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <Select
              value={replaceWith || undefined}
              onValueChange={(v) =>
                setReplaceWith(v as Id<"listStatuses">)
              }
            >
              <SelectTrigger className="flex-1">
                <SelectValue placeholder="Pick a replacement…" />
              </SelectTrigger>
              <SelectContent>
                {otherStatuses.map((s) => (
                  <SelectItem key={s._id} value={s._id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
    </div>
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
  const [color, setColor] = useState("#a9c6f2");
  const [category, setCategory] = useState<StatusCategory>("open");
  const [pending, setPending] = useState(false);
  const { toast } = useToast();

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        setPending(true);
        try {
          await onSubmit(name.trim(), color, category);
          setName("");
        } catch (e) {
          toast(errorMessage(e, "Couldn't create status"), { kind: "error" });
        } finally {
          setPending(false);
        }
      }}
      className="flex flex-col gap-2 rounded-xl border border-dashed border-border p-3 sm:flex-row sm:items-center"
    >
      <input
        type="color"
        value={color}
        onChange={(e) => setColor(e.currentTarget.value)}
        className="h-8 w-8 flex-shrink-0 cursor-pointer rounded-full border border-border"
        aria-label="New status color"
      />
      <Input
        placeholder="New status name"
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        className="flex-1"
      />
      <Select
        value={category}
        onValueChange={(v) => setCategory(v as StatusCategory)}
      >
        <SelectTrigger size="sm" className="w-40 flex-shrink-0 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(CATEGORY_LABEL) as StatusCategory[]).map((c) => (
            <SelectItem key={c} value={c}>
              {CATEGORY_LABEL[c]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        type="submit"
        size="sm"
        disabled={!name.trim() || pending}
        className="flex-shrink-0"
      >
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
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle>Custom fields</CardTitle>
        <CardDescription>
          Add columns to track per-task data beyond the defaults.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <RowList>
          {fields.length === 0 && (
            <EmptyRow>No custom fields yet.</EmptyRow>
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
        </RowList>

        <CreateFieldForm
          onSubmit={(name, type, options) =>
            create({ listId, name, type, options })
          }
        />
      </CardContent>
    </Card>
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
  const [deleting, setDeleting] = useState(false);
  const { toast } = useToast();
  if (deleting) return null;

  return (
    <div className="p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Badge
          variant="secondary"
          className="flex-shrink-0 text-[10px] uppercase tracking-wider"
        >
          {FIELD_TYPE_LABEL[field.type]}
        </Badge>
        <Input
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          onBlur={() => {
            if (name.trim() && name !== field.name) onRename(name.trim());
            else if (!name.trim()) setName(field.name);
          }}
          className="flex-1"
        />
        {field.type === "dropdown" && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setShowOptions((v) => !v)}
            className="flex-shrink-0"
          >
            Options ({field.options?.length ?? 0})
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Delete field"
          onClick={() => {
            setDeleting(true);
            toast(`"${field.name}" deleted, values go with it`, {
              action: { label: "Undo", onClick: () => setDeleting(false) },
              onExpire: () => onDelete(),
            });
          }}
          className="tap-target flex-shrink-0 text-muted-foreground hover:text-foreground"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {field.type === "dropdown" && showOptions && (
        <DropdownOptionsEditor
          options={field.options ?? []}
          onChange={onUpdateOptions}
        />
      )}
    </div>
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
  const [color, setColor] = useState("#a9c6f2");

  return (
    <div className="mt-3 rounded-xl bg-muted p-3">
      <ul className="space-y-1">
        {options.map((opt, i) => (
          <li
            key={opt.id}
            className="flex items-center gap-2 rounded-full bg-background px-3 py-1 text-sm"
          >
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: opt.color ?? "#c9ccd4" }}
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
              <X className="h-3 w-3" />
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex items-center gap-2">
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.currentTarget.value)}
          className="h-7 w-7 flex-shrink-0 cursor-pointer rounded-full border border-border"
          aria-label="Option color"
        />
        <Input
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          placeholder="New option"
          className="h-8 flex-1"
        />
        <Button
          type="button"
          size="sm"
          disabled={!draft.trim()}
          className="flex-shrink-0"
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
  const { toast } = useToast();

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
                    color: "#a9c6f2",
                  },
                ]
              : undefined,
          );
          setName("");
          setType("text");
        } catch (e) {
          toast(errorMessage(e, "Couldn't create field"), { kind: "error" });
        } finally {
          setPending(false);
        }
      }}
      className="flex flex-col gap-2 rounded-xl border border-dashed border-border p-3 sm:flex-row sm:items-center"
    >
      <Input
        placeholder="New field name"
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        className="flex-1"
      />
      <Select value={type} onValueChange={(v) => setType(v as FieldType)}>
        <SelectTrigger size="sm" className="w-36 flex-shrink-0 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(FIELD_TYPE_LABEL) as FieldType[]).map((t) => (
            <SelectItem key={t} value={t}>
              {FIELD_TYPE_LABEL[t]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        type="submit"
        size="sm"
        disabled={!name.trim() || pending}
        className="flex-shrink-0"
      >
        <Plus className="h-4 w-4" /> Add field
      </Button>
    </form>
  );
}

type AutomationDoc = Doc<"listAutomations">;
type Trigger = AutomationDoc["trigger"];
type ActionKind = AutomationDoc["action"]["kind"];

const TRIGGER_LABEL: Record<Trigger, string> = {
  task_created: "When a task is created",
  status_changed_to_complete: "When a task is marked complete",
};

const ACTION_LABEL: Record<ActionKind, string> = {
  assign_user: "Assign to user",
  set_priority: "Set priority",
  set_status: "Move to status",
  set_due_in_days: "Set due date in N days",
};

const PRIORITY_OPTIONS = ["urgent", "high", "normal", "low"] as const;

function AutomationsSection({
  listId,
  automations,
  statuses,
}: {
  listId: Id<"lists">;
  automations: AutomationDoc[];
  statuses: Doc<"listStatuses">[];
}) {
  const create = useMutation(api.listAutomations.create);
  const update = useMutation(api.listAutomations.update);
  const remove = useMutation(api.listAutomations.remove);

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle>Automations</CardTitle>
        <CardDescription>
          Trigger an action automatically when something happens to a task in
          this list.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <RowList>
          {automations.length === 0 && (
            <EmptyRow>No automations yet.</EmptyRow>
          )}
          {automations.map((automation) => (
            <AutomationRow
              key={automation._id}
              listId={listId}
              automation={automation}
              statuses={statuses}
              onChange={(patch) =>
                update({ automationId: automation._id, ...patch })
              }
              onDelete={() => remove({ automationId: automation._id })}
            />
          ))}
        </RowList>

        <CreateAutomationForm
          statuses={statuses}
          onSubmit={(trigger, action) => create({ listId, trigger, action })}
        />
      </CardContent>
    </Card>
  );
}

function AutomationRow({
  listId,
  automation,
  statuses,
  onChange,
  onDelete,
}: {
  listId: Id<"lists">;
  automation: AutomationDoc;
  statuses: Doc<"listStatuses">[];
  onChange: (patch: {
    trigger?: Trigger;
    action?: AutomationDoc["action"];
    enabled?: boolean;
  }) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
}) {
  const [deleting, setDeleting] = useState(false);
  const { toast } = useToast();
  if (deleting) return null;

  return (
    <div className={cn("p-3", !automation.enabled && "bg-muted/30 opacity-60")}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Checkbox
          checked={automation.enabled}
          onCheckedChange={(checked) => onChange({ enabled: checked === true })}
          aria-label="Enabled"
          className="flex-shrink-0"
        />
        <Select
          value={automation.trigger}
          onValueChange={(v) => onChange({ trigger: v as Trigger })}
        >
          <SelectTrigger size="sm" className="w-56 flex-shrink-0 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(TRIGGER_LABEL) as Trigger[]).map((t) => (
              <SelectItem key={t} value={t}>
                {TRIGGER_LABEL[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="flex-shrink-0 text-xs text-muted-foreground">→</span>
        <ActionEditor
          listId={listId}
          action={automation.action}
          statuses={statuses}
          onChange={(action) => onChange({ action })}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Delete automation"
          onClick={() => {
            setDeleting(true);
            toast("Automation deleted", {
              action: { label: "Undo", onClick: () => setDeleting(false) },
              onExpire: () => onDelete(),
            });
          }}
          className="tap-target ml-auto flex-shrink-0 text-muted-foreground hover:text-foreground"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function ActionEditor({
  listId,
  action,
  statuses,
  onChange,
}: {
  listId: Id<"lists">;
  action: AutomationDoc["action"];
  statuses: Doc<"listStatuses">[];
  onChange: (action: AutomationDoc["action"]) => Promise<unknown>;
}) {
  // People and agents assignable in this list, so "assign" is a picker,
  // never a raw ID field.
  const assignable = useQuery(api.agents.listAssignableForList, { listId });
  // Switching action kind resets the payload to a sensible default for
  // the new kind, so we never store mismatched fields.
  function setKind(kind: ActionKind) {
    if (kind === action.kind) return;
    if (kind === "assign_user") onChange({ kind, clerkId: "" });
    else if (kind === "set_priority") onChange({ kind, priority: "normal" });
    else if (kind === "set_status") {
      const first = statuses[0];
      if (first) onChange({ kind, statusId: first._id });
    } else if (kind === "set_due_in_days") onChange({ kind, days: 7 });
  }

  return (
    <div className="flex flex-1 flex-wrap items-center gap-2">
      <Select value={action.kind} onValueChange={(v) => setKind(v as ActionKind)}>
        <SelectTrigger size="sm" className="w-48 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(ACTION_LABEL) as ActionKind[]).map((k) => (
            <SelectItem key={k} value={k}>
              {ACTION_LABEL[k]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {action.kind === "assign_user" && (
        <Picker
          label={
            (assignable ?? []).find((a) => a.id === action.clerkId)?.name ??
            "Choose who…"
          }
          selectedId={action.clerkId || undefined}
          options={(assignable ?? []).map((a) => ({
            id: a.id,
            label: a.name,
            hint: a.kind === "agent" ? "agent" : undefined,
          }))}
          onSelect={(id) => onChange({ kind: "assign_user", clerkId: id })}
        />
      )}
      {action.kind === "set_priority" && (
        <Select
          value={action.priority}
          onValueChange={(v) =>
            onChange({
              kind: "set_priority",
              priority: v as "urgent" | "high" | "normal" | "low",
            })
          }
        >
          <SelectTrigger size="sm" className="w-28 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PRIORITY_OPTIONS.map((p) => (
              <SelectItem key={p} value={p} className="capitalize">
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {action.kind === "set_status" && (
        <Select
          value={action.statusId}
          onValueChange={(v) =>
            onChange({
              kind: "set_status",
              statusId: v as Id<"listStatuses">,
            })
          }
        >
          <SelectTrigger size="sm" className="w-40 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {statuses.map((s) => (
              <SelectItem key={s._id} value={s._id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {action.kind === "set_due_in_days" && (
        <Input
          type="number"
          value={action.days}
          onChange={(e) =>
            onChange({
              kind: "set_due_in_days",
              days: Number(e.currentTarget.value) || 0,
            })
          }
          className="h-8 w-20 text-xs"
        />
      )}
    </div>
  );
}

function CreateAutomationForm({
  statuses,
  onSubmit,
}: {
  statuses: Doc<"listStatuses">[];
  onSubmit: (
    trigger: Trigger,
    action: AutomationDoc["action"],
  ) => Promise<unknown>;
}) {
  const [pending, setPending] = useState(false);
  const { toast } = useToast();

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        try {
          const firstStatus = statuses[0];
          await onSubmit(
            "task_created",
            firstStatus
              ? { kind: "set_status", statusId: firstStatus._id }
              : { kind: "set_priority", priority: "normal" },
          );
        } catch (e) {
          toast(errorMessage(e, "Couldn't create automation"), {
            kind: "error",
          });
        } finally {
          setPending(false);
        }
      }}
      className="flex justify-center"
    >
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        <Plus className="h-4 w-4" /> Add automation
      </Button>
    </form>
  );
}

// Keep in sync with MAX_FORMS_PER_LIST in convex/forms.ts — this only
// hides the "Add form" affordance early; the server is the real limit.
const MAX_FORMS_PER_LIST = 5;

function FormsSection({ listId }: { listId: Id<"lists"> }) {
  const forms = useQuery(api.forms.listForList, { listId });
  const create = useMutation(api.forms.create);
  const update = useMutation(api.forms.update);
  const remove = useMutation(api.forms.remove);
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);

  return (
    <Card className="rounded-2xl">
      <CardHeader>
        <CardTitle>Form</CardTitle>
        <CardDescription>
          Share a public link that lets anyone submit a request without an
          account — each submission becomes a task on this list.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {forms === undefined ? (
          <div className="h-16 animate-pulse rounded-xl bg-muted" />
        ) : (
          <>
            <RowList>
              {forms.length === 0 && <EmptyRow>No forms yet.</EmptyRow>}
              {forms.map((form) => (
                <FormRow
                  key={form._id}
                  form={form}
                  onUpdate={(patch) => update({ formId: form._id, ...patch })}
                  onDelete={() => remove({ formId: form._id })}
                />
              ))}
            </RowList>

            {forms.length < MAX_FORMS_PER_LIST && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!title.trim()) return;
                  setPending(true);
                  try {
                    await create({ listId, title: title.trim() });
                    setTitle("");
                  } finally {
                    setPending(false);
                  }
                }}
                className="flex flex-col gap-2 rounded-xl border border-dashed border-border p-3 sm:flex-row sm:items-center"
              >
                <Input
                  placeholder="New form title"
                  value={title}
                  onChange={(e) => setTitle(e.currentTarget.value)}
                  className="flex-1"
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={!title.trim() || pending}
                  className="flex-shrink-0"
                >
                  <Plus className="h-4 w-4" /> Add form
                </Button>
              </form>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function FormRow({
  form,
  onUpdate,
  onDelete,
}: {
  form: Doc<"forms">;
  onUpdate: (patch: {
    title?: string;
    askDescription?: boolean;
    askPriority?: boolean;
    askEmail?: boolean;
    enabled?: boolean;
  }) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
}) {
  const [title, setTitle] = useState(form.title);
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { toast } = useToast();
  if (deleting) return null;

  const path = `/f/${form.token}`;

  return (
    <div className="p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Checkbox
          checked={form.enabled}
          onCheckedChange={(checked) =>
            onUpdate({ enabled: checked === true })
          }
          aria-label="Form enabled"
          className="flex-shrink-0"
        />
        <Input
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          onBlur={() => {
            if (title.trim() && title !== form.title) {
              onUpdate({ title: title.trim() });
            } else if (!title.trim()) {
              setTitle(form.title);
            }
          }}
          className="flex-1"
        />
        <Link
          href={path}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {path}
        </Link>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Copy form link"
          onClick={async () => {
            await navigator.clipboard.writeText(
              `${window.location.origin}${path}`,
            );
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="tap-target flex-shrink-0 text-muted-foreground hover:text-foreground"
        >
          {copied ? (
            <Check className="h-4 w-4 text-positive" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Delete form"
          onClick={() => {
            setDeleting(true);
            toast(`"${form.title}" deleted`, {
              action: { label: "Undo", onClick: () => setDeleting(false) },
              onExpire: () => onDelete(),
            });
          }}
          className="tap-target flex-shrink-0 text-muted-foreground hover:text-foreground"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap gap-4 border-t border-border pt-3 text-xs text-muted-foreground">
        <label className="flex items-center gap-1.5">
          <Checkbox
            checked={form.askDescription ?? false}
            onCheckedChange={(checked) =>
              onUpdate({ askDescription: checked === true })
            }
          />
          Ask for description
        </label>
        <label className="flex items-center gap-1.5">
          <Checkbox
            checked={form.askPriority ?? false}
            onCheckedChange={(checked) =>
              onUpdate({ askPriority: checked === true })
            }
          />
          Ask for priority
        </label>
        <label className="flex items-center gap-1.5">
          <Checkbox
            checked={form.askEmail ?? false}
            onCheckedChange={(checked) =>
              onUpdate({ askEmail: checked === true })
            }
          />
          Ask for email
        </label>
      </div>
    </div>
  );
}
