"use client";

import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Card } from "@/components/ui/card";
import { Monogram } from "@/components/dashboard/monogram";
import { Picker, type PickerOption } from "@/components/ui/picker";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { fromDateInputValue, toDateInputValue } from "@/lib/dates";

// The project's identity rail: health, owner, target date.
//
// These used to live on the list Overview back when a list *was* a project.
// They belong to the Project now, and they live in one component so the
// project page can't drift from whatever else chooses to render them.

export type ProjectStatus = NonNullable<Doc<"projects">["projectStatus"]>;

export const STATUS_CHIPS: {
  key: ProjectStatus;
  label: string;
  className: string;
}[] = [
  // `amber`, `rose` and `slate` were not pastel tokens — the ramp is
  // blue/red/yellow/green/purple/pink — so Tailwind generated no rule for
  // three of these four and they have been colourless pills since they
  // shipped. A class naming a colour that does not exist fails silently, which
  // is why only the one that DID resolve ("On track", near-white ink on pale
  // green in dark, 1.11:1) was ever reported.
  { key: "on_track", label: "On track", className: "bg-pastel-green" },
  { key: "at_risk", label: "At risk", className: "bg-pastel-yellow" },
  { key: "off_track", label: "Off track", className: "bg-pastel-red" },
  // No pastel grey in the ramp, and inventing one to say "nothing is
  // happening" would be a colour carrying no meaning. `bg-muted` is the
  // product's own quiet surface and it is defined in both themes, so this chip
  // takes the inherited foreground and is correct either way round.
  { key: "paused", label: "Paused", className: "bg-muted" },
];

export function ProjectStatusCard({ project }: { project: Doc<"projects"> }) {
  const updateMeta = useMutation(api.projects.updateMeta);
  const { toast } = useToast();

  async function setStatus(key: ProjectStatus) {
    // Clicking the active chip clears it — a project with no declared health
    // is a real state, not a missing one.
    const next = project.projectStatus === key ? null : key;
    try {
      await updateMeta({ projectId: project._id, projectStatus: next });
      toast("Saved");
    } catch (e) {
      toast(errorMessage(e, "Couldn't save status"), { kind: "error" });
    }
  }

  return (
    <Card className="rounded-2xl p-5">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Status
      </span>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {STATUS_CHIPS.map((chip) => {
          const active = project.projectStatus === chip.key;
          return (
            <button
              key={chip.key}
              type="button"
              aria-pressed={active}
              onClick={() => void setStatus(chip.key)}
              className={cn(
                // No `text-foreground`: the chip paints itself a fixed pale
                // pastel, and `text-foreground` flips to near-white in dark —
                // "On track" measured 1.11:1. The pastel fill carries its own
                // ink now (see globals.css), so saying nothing is correct in
                // both themes and saying `text-foreground` was correct in one.
                "rounded-full px-3 py-1.5 text-xs font-medium transition-opacity",
                chip.className,
                !active && "opacity-45 hover:opacity-80",
              )}
            >
              {chip.label}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

export function ProjectOwnerCard({
  project,
  anyListId,
}: {
  project: Doc<"projects">;
  /**
   * Any list inside the project. The assignable-actor query is list-scoped
   * (it resolves the space's members and the agents allowed to work there),
   * and every list in a project shares that scope — so any one of them
   * answers the question. Undefined when the project has no lists yet, in
   * which case there is nobody to pick from anyway.
   */
  anyListId?: Id<"lists">;
}) {
  const options = useQuery(
    api.agents.listAssignableForList,
    anyListId ? { listId: anyListId } : "skip",
  );
  const updateMeta = useMutation(api.projects.updateMeta);
  const { toast } = useToast();

  const owner = options?.find((o) => o.id === project.ownerActorId);

  async function setOwner(id: string | null) {
    try {
      await updateMeta({ projectId: project._id, ownerActorId: id });
      toast("Saved");
    } catch (e) {
      toast(errorMessage(e, "Couldn't save owner"), { kind: "error" });
    }
  }

  const pickerOptions: PickerOption[] = (options ?? []).map((o) => ({
    id: o.id,
    label: o.name,
    hint: o.kind === "agent" ? "agent" : undefined,
  }));

  return (
    <Card className="rounded-2xl p-5">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Owner
      </span>
      <div className="mt-3 space-y-3">
        {owner && (
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Monogram name={owner.name} size="sm" />
              <span className="truncate text-sm font-medium">{owner.name}</span>
            </div>
            <button
              type="button"
              onClick={() => void setOwner(null)}
              className="flex-shrink-0 text-xs text-muted-foreground hover:text-foreground"
            >
              Remove
            </button>
          </div>
        )}
        {anyListId ? (
          <Picker
            label={owner ? "Change owner…" : "Assign an owner…"}
            dashed
            selectedId={owner?.id}
            options={pickerOptions}
            onSelect={(id) => void setOwner(id)}
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            Add a list to this project to pick an owner.
          </p>
        )}
      </div>
    </Card>
  );
}

export function ProjectTargetDateCard({
  project,
}: {
  project: Doc<"projects">;
}) {
  const updateMeta = useMutation(api.projects.updateMeta);
  const { toast } = useToast();

  async function setDate(value: number | null) {
    try {
      await updateMeta({ projectId: project._id, targetDate: value });
      toast("Saved");
    } catch (e) {
      toast(errorMessage(e, "Couldn't save target date"), { kind: "error" });
    }
  }

  return (
    <Card className="rounded-2xl p-5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Target date
        </span>
        {project.targetDate !== undefined && (
          <button
            type="button"
            onClick={() => void setDate(null)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        )}
      </div>
      <input
        type="date"
        aria-label="Target date"
        value={project.targetDate ? toDateInputValue(project.targetDate) : ""}
        onChange={(e) =>
          void setDate(fromDateInputValue(e.currentTarget.value) ?? null)
        }
        className="soft-field mt-3 w-full px-3 py-2 text-sm"
      />
    </Card>
  );
}

/** Freeform project notes: decisions, links, the things a task can't hold. */
export function ProjectNotesCard({ project }: { project: Doc<"projects"> }) {
  const updateMeta = useMutation(api.projects.updateMeta);
  const { toast } = useToast();

  return (
    <Card className="rounded-2xl p-5">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Notes
      </span>
      <textarea
        defaultValue={project.notes ?? ""}
        rows={5}
        placeholder="Decisions, links, constraints…"
        // Blur-persisted, like every other quiet field in the app: typing
        // should not fire a mutation per keystroke.
        onBlur={(e) => {
          const next = e.currentTarget.value;
          if (next === (project.notes ?? "")) return;
          void updateMeta({ projectId: project._id, notes: next })
            .then(() => toast("Saved"))
            .catch((err) =>
              toast(errorMessage(err, "Couldn't save notes"), {
                kind: "error",
              }),
            );
        }}
        className="soft-field mt-3 w-full resize-y px-3 py-2 text-sm"
      />
    </Card>
  );
}
