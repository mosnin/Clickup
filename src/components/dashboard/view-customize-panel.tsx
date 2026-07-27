"use client";

import { useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { BorderBeam } from "@/components/ui/beam";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useReducedMotion } from "motion/react";
import { Stagger, StaggerItem } from "@/components/motion";
import { useToast } from "@/components/toast";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  BUILTIN_FIELDS,
  GROUP_OPTIONS,
  SUBTASK_OPTIONS,
  allFieldKeys,
  isBuiltinFieldKey,
  resolveVisibleFields,
  writeViewSettingsToParams,
  type GroupBy,
  type SubtaskMode,
  type ViewSettings,
} from "@/lib/view-settings";

// "Customize view" — the one place a project's presentation is configured.
// Everything here is wired to real rendering (see list-view / board-view);
// nothing is a placeholder toggle. State lives in the URL (so "Copy link to
// view" reproduces exactly what you see) and in localStorage per list.

// Views `lists.updateMeta` accepts as a project default. Overview, Timeline
// and Network aren't in that union yet, so the action explains itself
// instead of failing on the server.
const DEFAULTABLE_VIEWS = new Set([
  "list",
  "board",
  "calendar",
  "gantt",
  "table",
  "workload",
]);

type DefaultableView = "list" | "board" | "calendar" | "gantt" | "table" | "workload";

// Which sections the active view actually acts on. A setting that can't bite
// on the current view is still editable (it applies the moment you switch),
// but says so rather than pretending.
const APPLIES: Record<string, { display: boolean; group: boolean; fields: boolean }> = {
  list: { display: true, group: true, fields: true },
  board: { display: true, group: false, fields: false },
  table: { display: true, group: false, fields: true },
};

export function ViewCustomizePanel({
  listId,
  view,
  defaultView,
  settings,
  update,
  reset,
  customized,
  customFields,
}: {
  listId: Id<"lists">;
  view: string;
  /** The list's configured default view, if any. */
  defaultView?: string | null;
  settings: ViewSettings;
  update: (patch: Partial<ViewSettings>) => void;
  reset: () => void;
  customized: boolean;
  customFields: Doc<"customFields">[];
}) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const reduced = useReducedMotion();

  const applies = APPLIES[view] ?? { display: false, group: false, fields: false };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="flex-shrink-0">
          Customize
          {customized && (
            <>
              <span
                aria-hidden
                className="ml-0.5 h-1.5 w-1.5 rounded-full bg-foreground"
              />
              <span className="sr-only">(customized)</span>
            </>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent
        side={isMobile ? "bottom" : "right"}
        className={cn(
          "gap-0 p-0",
          isMobile
            ? "h-[85vh] max-h-[85vh] rounded-t-2xl"
            : "w-full sm:max-w-md",
        )}
      >
        <SheetHeader className="px-5 pb-3 pt-5">
          <SheetTitle className="text-base tracking-tight">
            Customize view
          </SheetTitle>
          <SheetDescription className="text-xs">
            Saved for you on this project, and carried in the link — copy it
            and whoever opens it sees the same view.
          </SheetDescription>
        </SheetHeader>

        <div className="min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6">
          {/* The beam is emphasis, not decoration: it only lights up once
              this view has actually been customized, and stays still for
              anyone who asked for reduced motion. */}
          <BorderBeam
            size="md"
            colorVariant="colorful"
            theme="auto"
            active={customized && !reduced}
            className="flex min-w-0"
          >
            <div className="min-w-0 flex-1 rounded-2xl">
              <Stagger className="min-w-0 space-y-3">
                <DisplaySection
                  settings={settings}
                  update={update}
                  note={
                    applies.display
                      ? undefined
                      : "Closed tasks are hidden or shown on every view; wrapping, locations and parent names shape the List and Board rows."
                  }
                />
                <FieldsSection
                  settings={settings}
                  update={update}
                  customFields={customFields}
                  note={
                    applies.fields
                      ? undefined
                      : "Fields drive the List and Table columns."
                  }
                />
                <GroupSection
                  settings={settings}
                  update={update}
                  note={
                    applies.group
                      ? undefined
                      : "Grouping applies to the List view; Board groups by status column."
                  }
                />
                <SubtasksSection settings={settings} update={update} />
                <ViewActionsSection
                  listId={listId}
                  view={view}
                  defaultView={defaultView}
                  settings={settings}
                  customized={customized}
                  reset={reset}
                  onDone={() => setOpen(false)}
                />
              </Stagger>
            </div>
          </BorderBeam>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Section chrome ───────────────────────────────────────────────────────

function Section({
  title,
  meta,
  note,
  children,
}: {
  title: string;
  meta?: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <StaggerItem>
      <section className="bento-tile min-w-0 p-4">
        <header className="flex min-w-0 items-baseline justify-between gap-2">
          <h3 className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </h3>
          {meta && (
            <span className="flex-shrink-0 text-[11px] text-muted-foreground">
              {meta}
            </span>
          )}
        </header>
        <div className="mt-2 min-w-0">{children}</div>
        {note && (
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            {note}
          </p>
        )}
      </section>
    </StaggerItem>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{label}</p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {hint}
        </p>
      </div>
      <div className="pt-0.5">
        <Switch label={label} checked={checked} onCheckedChange={onChange} />
      </div>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (next: T) => void;
  options: readonly { key: T; label: string }[];
  ariaLabel: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="segmented max-w-full overflow-x-auto overscroll-x-contain"
    >
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="tab"
          aria-selected={value === o.key}
          onClick={() => onChange(o.key)}
          className={cn(value === o.key && "segmented-on")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Sections ─────────────────────────────────────────────────────────────

function DisplaySection({
  settings,
  update,
  note,
}: {
  settings: ViewSettings;
  update: (patch: Partial<ViewSettings>) => void;
  note?: string;
}) {
  return (
    <Section title="Display" note={note}>
      <div className="divide-y divide-border/60">
        <ToggleRow
          label="Show empty statuses"
          hint="Keep a status group or Board column visible when nothing is in it."
          checked={settings.emptyStatuses}
          onChange={(emptyStatuses) => update({ emptyStatuses })}
        />
        <ToggleRow
          label="Wrap text"
          hint="Show long titles in full instead of cutting them to one line."
          checked={settings.wrapText}
          onChange={(wrapText) => update({ wrapText })}
        />
        <ToggleRow
          label="Show closed tasks"
          hint="Include tasks that have been moved into a closed status."
          checked={settings.showClosed}
          onChange={(showClosed) => update({ showClosed })}
        />
        <ToggleRow
          label="Show task locations"
          hint="Add the Space › Project › List breadcrumb to every task."
          checked={settings.showLocation}
          onChange={(showLocation) => update({ showLocation })}
        />
        <ToggleRow
          label="Show subtask parent names"
          hint="Label each subtask with the task it belongs to."
          checked={settings.showSubtaskParents}
          onChange={(showSubtaskParents) => update({ showSubtaskParents })}
        />
      </div>
    </Section>
  );
}

function FieldsSection({
  settings,
  update,
  customFields,
  note,
}: {
  settings: ViewSettings;
  update: (patch: Partial<ViewSettings>) => void;
  customFields: Doc<"customFields">[];
  note?: string;
}) {
  const customIds = useMemo(
    () => customFields.map((f) => f._id as string),
    [customFields],
  );
  const visible = resolveVisibleFields(settings, customIds);
  const hidden = allFieldKeys(customIds).filter((k) => !visible.includes(k));
  const rows = [...visible, ...hidden];

  function labelFor(key: string): string {
    if (isBuiltinFieldKey(key)) {
      return BUILTIN_FIELDS.find((f) => f.key === key)?.label ?? key;
    }
    return customFields.find((f) => f._id === key)?.name ?? "Field";
  }

  function toggle(key: string) {
    update({
      fields: visible.includes(key)
        ? visible.filter((k) => k !== key)
        : [...visible, key],
    });
  }

  function move(key: string, delta: -1 | 1) {
    const from = visible.indexOf(key);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= visible.length) return;
    const next = [...visible];
    next[from] = visible[to];
    next[to] = visible[from];
    update({ fields: next });
  }

  return (
    <Section
      title="Fields"
      meta={`${visible.length} shown`}
      note={note ?? "Visible fields become the row metadata in List and the columns in Table, in this order."}
    >
      <ul className="min-w-0 space-y-0.5">
        {rows.map((key) => {
          const on = visible.includes(key);
          const index = visible.indexOf(key);
          return (
            <li
              key={key}
              className="flex min-w-0 items-center gap-2 rounded-lg px-1 py-1.5"
            >
              <Checkbox
                checked={on}
                onCheckedChange={() => toggle(key)}
                aria-label={`Show ${labelFor(key)}`}
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-sm",
                  !on && "text-muted-foreground",
                )}
              >
                {labelFor(key)}
              </span>
              <span className="flex flex-shrink-0 items-center">
                <button
                  type="button"
                  aria-label={`Move ${labelFor(key)} up`}
                  disabled={!on || index <= 0}
                  onClick={() => move(key, -1)}
                  className="tap-target inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${labelFor(key)} down`}
                  disabled={!on || index < 0 || index >= visible.length - 1}
                  onClick={() => move(key, 1)}
                  className="tap-target inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-background hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function GroupSection({
  settings,
  update,
  note,
}: {
  settings: ViewSettings;
  update: (patch: Partial<ViewSettings>) => void;
  note?: string;
}) {
  return (
    <Section title="Group by" meta={groupLabel(settings.group)} note={note}>
      <Segmented
        ariaLabel="Group tasks by"
        value={settings.group}
        options={GROUP_OPTIONS}
        onChange={(group: GroupBy) => update({ group })}
      />
    </Section>
  );
}

function groupLabel(group: GroupBy): string {
  return GROUP_OPTIONS.find((o) => o.key === group)?.label ?? "None";
}

function SubtasksSection({
  settings,
  update,
}: {
  settings: ViewSettings;
  update: (patch: Partial<ViewSettings>) => void;
}) {
  const hint = SUBTASK_OPTIONS.find((o) => o.key === settings.subtasks)?.hint;
  return (
    <Section
      title="Subtasks"
      meta={
        SUBTASK_OPTIONS.find((o) => o.key === settings.subtasks)?.label ??
        "Collapsed"
      }
      note={hint}
    >
      <Segmented
        ariaLabel="Subtask display"
        value={settings.subtasks}
        options={SUBTASK_OPTIONS}
        onChange={(subtasks: SubtaskMode) => update({ subtasks })}
      />
    </Section>
  );
}

function ViewActionsSection({
  listId,
  view,
  defaultView,
  settings,
  customized,
  reset,
  onDone,
}: {
  listId: Id<"lists">;
  view: string;
  defaultView?: string | null;
  settings: ViewSettings;
  customized: boolean;
  reset: () => void;
  onDone: () => void;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const updateMeta = useMutation(api.lists.updateMeta);
  const toggleFavorite = useMutation(api.favorites.toggle);
  const isFavorite = useQuery(api.favorites.isFavorite, {
    entityType: "list",
    entityId: listId,
  });

  const canDefault = DEFAULTABLE_VIEWS.has(view);
  const alreadyDefault = defaultView === view;

  async function setAsDefault() {
    try {
      await updateMeta({ listId, defaultView: view as DefaultableView });
      toast("Set as the default view for this project");
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      toast(
        raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() ||
          "Couldn't set the default view",
        { kind: "error" },
      );
    }
  }

  async function copyLink() {
    // The link is explicit about everything: the view (a bare URL would fall
    // back to the project default, which may be a different view) plus the
    // filters and customization already in the address bar.
    const params = writeViewSettingsToParams(
      new URLSearchParams(searchParams.toString()),
      settings,
    );
    params.set("view", view);
    // The task peek overlay is per-session, not part of the view.
    params.delete("peek");
    const url = `${window.location.origin}${pathname}?${params.toString()}`;
    try {
      await navigator.clipboard.writeText(url);
      toast("Link to this view copied");
    } catch {
      toast("Couldn't copy — your browser blocked clipboard access", {
        kind: "error",
      });
    }
  }

  async function favorite() {
    try {
      const result = await toggleFavorite({
        entityType: "list",
        entityId: listId,
      });
      toast(result.favorited ? "Added to favorites" : "Removed from favorites");
    } catch {
      toast("Couldn't update favorites", { kind: "error" });
    }
  }

  return (
    <Section
      title="This view"
      note={
        canDefault
          ? undefined
          : "Overview, Timeline and Network can't be a project default yet."
      }
    >
      <div className="flex min-w-0 flex-col gap-2">
        <ActionRow
          label="Set as default view"
          hint={
            alreadyDefault
              ? "Everyone opening this project lands here."
              : "Open this project on this view by default."
          }
          action={
            <Button
              size="sm"
              variant="outline"
              disabled={!canDefault || alreadyDefault}
              onClick={setAsDefault}
            >
              {alreadyDefault ? "Default" : "Set"}
            </Button>
          }
        />
        <ActionRow
          label="Copy link to view"
          hint="Reproduces this exact setup — view, filters and everything above."
          action={
            <Button size="sm" variant="outline" onClick={copyLink}>
              Copy
            </Button>
          }
        />
        <ActionRow
          label="Favorite"
          hint="Pin this project to the top of your sidebar."
          action={
            <Switch
              label="Favorite this project"
              checked={!!isFavorite}
              onCheckedChange={() => void favorite()}
            />
          }
        />
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={!customized}
          onClick={reset}
          className="px-2 text-muted-foreground hover:text-foreground"
        >
          Reset to defaults
        </Button>
        <Button size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </Section>
  );
}

function ActionRow({
  label,
  hint,
  action,
}: {
  label: string;
  hint: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{label}</p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {hint}
        </p>
      </div>
      <div className="flex-shrink-0 pt-0.5">{action}</div>
    </div>
  );
}
