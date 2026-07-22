"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { Boxes, FileText, LayoutGrid, Lock, Plus, X } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { AnimatedBar, Stagger, StaggerItem } from "@/components/motion";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Monogram } from "@/components/dashboard/monogram";
import { InlineCreate } from "@/components/dashboard/inline-create";
import { PageHeader } from "@/components/dashboard/page-header";
import { Picker } from "@/components/ui/picker";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/toast";

// The Space page: a ClickUp-style Space now has identity (name/color/
// description), privacy (creator/owner-governed membership), an archive
// state, and default statuses for new lists. Two tabs — Overview (what's
// inside) and Settings (identity + governance) — driven by local state, no
// URL param needed since neither is deep-linkable content.

type Overview = NonNullable<
  ReturnType<typeof useQuery<typeof api.spaces.overview>>
>;
type SpaceDoc = Overview["space"];
type ListRollup = Overview["lists"][number];
type MemberRow = Overview["members"][number];
type StatusCategory = "open" | "in_progress" | "complete" | "closed";
type DefaultStatus = { name: string; color: string; category: StatusCategory };

// The 8 sanctioned swatch hexes — pastel accent tokens plus ink, used for
// both a Space's identity color and (cycled) new default-status colors.
const SWATCHES = [
  "#a9c6f2",
  "#f2b3ab",
  "#f2c291",
  "#c9e8b8",
  "#d9c9f2",
  "#f2c9e4",
  "#c9ccd4",
  "#101012",
];

const STATUS_CHIP: Record<
  NonNullable<ListRollup["projectStatus"]>,
  { label: string; className: string }
> = {
  on_track: {
    label: "On track",
    className: "bg-pastel-green dark:text-neutral-900",
  },
  at_risk: {
    label: "At risk",
    className: "bg-pastel-yellow dark:text-neutral-900",
  },
  off_track: {
    label: "Off track",
    className: "bg-pastel-red dark:text-neutral-900",
  },
  paused: { label: "Paused", className: "bg-muted" },
};

const CATEGORY_LABEL: Record<StatusCategory, string> = {
  open: "Open",
  in_progress: "In progress",
  complete: "Complete",
  closed: "Closed",
};

function errorMessage(e: unknown, fallback: string): string {
  const raw = e instanceof Error ? e.message : String(e);
  return (
    raw.split("Uncaught Error:").pop()?.split("\n")[0]?.trim() || fallback
  );
}

export function SpaceView({ spaceId }: { spaceId: string }) {
  const id = spaceId as Id<"spaces">;
  const overview = useQuery(api.spaces.overview, { spaceId: id });
  const [tab, setTab] = useState<"overview" | "settings">("overview");

  if (overview === undefined) {
    return <PageSkeleton />;
  }
  if (overview === null) {
    return (
      <div className="rounded-2xl panel p-10 text-center">
        <p className="text-sm text-muted-foreground">
          This Space doesn&apos;t exist or you don&apos;t have access to it.
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

  const { space, lists, docs, whiteboards, members, canGovern } = overview;
  const showWhiteboards = space.features?.whiteboards !== false;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Boxes}
        title={space.name}
        context={
          (space.private || space.archivedAt) && (
            <>
              {space.private && (
                <Badge variant="outline" className="gap-1">
                  <Lock className="h-3 w-3" /> Private
                </Badge>
              )}
              {space.archivedAt && (
                <Badge variant="outline" className="uppercase tracking-wider">
                  Archived
                </Badge>
              )}
            </>
          )
        }
      >
        <nav
          aria-label="Space tabs"
          className="flex items-center gap-1 pb-2 text-sm"
        >
          <button
            type="button"
            onClick={() => setTab("overview")}
            aria-pressed={tab === "overview"}
            className={cn(
              "rounded-md px-3 py-1.5 font-medium transition-colors",
              tab === "overview"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            Overview
          </button>
          <button
            type="button"
            onClick={() => setTab("settings")}
            aria-pressed={tab === "settings"}
            className={cn(
              "rounded-md px-3 py-1.5 font-medium transition-colors",
              tab === "settings"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            Settings
          </button>
        </nav>
      </PageHeader>

      {tab === "overview" ? (
        <OverviewTab
          spaceId={id}
          lists={lists}
          docs={docs}
          whiteboards={whiteboards}
          showWhiteboards={showWhiteboards}
        />
      ) : (
        <SettingsTab
          spaceId={id}
          space={space}
          members={members}
          canGovern={canGovern}
        />
      )}
    </div>
  );
}

// ── Overview tab ──────────────────────────────────────────────────────────

function OverviewTab({
  spaceId,
  lists,
  docs,
  whiteboards,
  showWhiteboards,
}: {
  spaceId: Id<"spaces">;
  lists: Overview["lists"];
  docs: Overview["docs"];
  whiteboards: Overview["whiteboards"];
  showWhiteboards: boolean;
}) {
  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Projects
        </h2>
        <Stagger className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {lists.map((list) => (
            <StaggerItem key={list.listId}>
              <ProjectCard list={list} />
            </StaggerItem>
          ))}
          <StaggerItem>
            <NewListCard spaceId={spaceId} />
          </StaggerItem>
        </Stagger>
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          {showWhiteboards ? "Docs & whiteboards" : "Docs"}
        </h2>
        {docs.length === 0 && (!showWhiteboards || whiteboards.length === 0) ? (
          <div className="mt-3 rounded-2xl panel">
            <EmptyState
              compact
              title="Nothing here yet"
              message={
                showWhiteboards
                  ? "Create a doc or whiteboard to start writing or sketching inside this Space."
                  : "Create a doc to start writing inside this Space."
              }
            />
          </div>
        ) : (
          <div
            className={cn(
              "mt-3 grid gap-3",
              showWhiteboards && "sm:grid-cols-2",
            )}
          >
            <DocList spaceId={spaceId} docs={docs} />
            {showWhiteboards && (
              <WhiteboardList spaceId={spaceId} whiteboards={whiteboards} />
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function ProjectCard({ list }: { list: ListRollup }) {
  const pct = list.total > 0 ? (list.done / list.total) * 100 : 0;
  const chip = list.projectStatus ? STATUS_CHIP[list.projectStatus] : null;

  return (
    <Link
      href={`/dashboard/l/${list.listId}`}
      className="lift block rounded-2xl panel p-5 hover:border-foreground/25"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-semibold">{list.name}</p>
          {list.folder !== null && (
            <p className="truncate text-xs text-muted-foreground">
              in {list.folder}
            </p>
          )}
        </div>
        {chip && (
          <span
            className={cn(
              "flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium text-foreground",
              chip.className,
            )}
          >
            {chip.label}
          </span>
        )}
      </div>

      {list.description && (
        <p className="mt-2 line-clamp-1 text-sm text-muted-foreground">
          {list.description}
        </p>
      )}

      <div className="mt-4">
        <AnimatedBar
          pct={pct}
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          barClassName="block h-full rounded-full bg-foreground"
        />
        <p className="mt-1.5 text-xs text-muted-foreground">
          {list.done} of {list.total} done
        </p>
      </div>

      {list.overdue > 0 && (
        <p className="mt-3 text-xs text-danger">{list.overdue} overdue</p>
      )}
    </Link>
  );
}

function NewListCard({ spaceId }: { spaceId: Id<"spaces"> }) {
  const [adding, setAdding] = useState(false);
  const createList = useMutation(api.lists.create);
  const router = useRouter();
  const { toast } = useToast();

  if (adding) {
    return (
      <div className="flex h-full min-h-[152px] flex-col justify-center rounded-2xl panel p-5">
        <InlineCreate
          placeholder="List name…"
          onCancel={() => setAdding(false)}
          onSubmit={async (name) => {
            try {
              const listId = await createList({
                name,
                parentType: "space",
                parentId: spaceId,
              });
              router.push(`/dashboard/l/${listId}`);
            } catch (e) {
              toast(errorMessage(e, "Couldn't create list"), {
                kind: "error",
              });
              setAdding(false);
            }
          }}
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setAdding(true)}
      className="lift flex h-full min-h-[152px] w-full flex-col items-center justify-center gap-2 rounded-2xl bento-tile p-5 text-sm font-medium text-muted-foreground hover:text-foreground"
    >
      <Plus className="h-4 w-4" />
      New list
    </button>
  );
}

function DocList({
  spaceId,
  docs,
}: {
  spaceId: Id<"spaces">;
  docs: Overview["docs"];
}) {
  const [adding, setAdding] = useState(false);
  const createDoc = useMutation(api.docs.create);
  const router = useRouter();
  const { toast } = useToast();

  return (
    <div className="rounded-2xl panel p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Docs
      </h3>
      <ul className="mt-2 space-y-0.5">
        {docs.map((d) => (
          <li key={d.docId}>
            <Link
              href={`/dashboard/d/${d.docId}`}
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-muted"
            >
              <FileText
                className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground"
                aria-hidden
              />
              <span className="truncate">{d.title}</span>
            </Link>
          </li>
        ))}
        {docs.length === 0 && !adding && (
          <li className="px-2 py-1.5 text-xs text-muted-foreground">
            No docs yet.
          </li>
        )}
      </ul>
      {adding ? (
        <div className="mt-1.5">
          <InlineCreate
            placeholder="Doc title…"
            onCancel={() => setAdding(false)}
            onSubmit={async (title) => {
              try {
                const docId = await createDoc({
                  parentType: "space",
                  parentId: spaceId,
                  title,
                });
                router.push(`/dashboard/d/${docId}`);
              } catch (e) {
                toast(errorMessage(e, "Couldn't create doc"), {
                  kind: "error",
                });
                setAdding(false);
              }
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-1.5 flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus className="h-3 w-3" /> New doc
        </button>
      )}
    </div>
  );
}

function WhiteboardList({
  spaceId,
  whiteboards,
}: {
  spaceId: Id<"spaces">;
  whiteboards: Overview["whiteboards"];
}) {
  const [adding, setAdding] = useState(false);
  const createWhiteboard = useMutation(api.whiteboards.create);
  const router = useRouter();
  const { toast } = useToast();

  return (
    <div className="rounded-2xl panel p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Whiteboards
      </h3>
      <ul className="mt-2 space-y-0.5">
        {whiteboards.map((w) => (
          <li key={w.whiteboardId}>
            <Link
              href={`/dashboard/wb/${w.whiteboardId}`}
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-muted"
            >
              <LayoutGrid
                className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground"
                aria-hidden
              />
              <span className="truncate">{w.title}</span>
            </Link>
          </li>
        ))}
        {whiteboards.length === 0 && !adding && (
          <li className="px-2 py-1.5 text-xs text-muted-foreground">
            No whiteboards yet.
          </li>
        )}
      </ul>
      {adding ? (
        <div className="mt-1.5">
          <InlineCreate
            placeholder="Whiteboard title…"
            onCancel={() => setAdding(false)}
            onSubmit={async (title) => {
              try {
                const wbId = await createWhiteboard({
                  parentType: "space",
                  parentId: spaceId,
                  title,
                });
                router.push(`/dashboard/wb/${wbId}`);
              } catch (e) {
                toast(errorMessage(e, "Couldn't create whiteboard"), {
                  kind: "error",
                });
                setAdding(false);
              }
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-1.5 flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus className="h-3 w-3" /> New whiteboard
        </button>
      )}
    </div>
  );
}

// ── Settings tab ──────────────────────────────────────────────────────────

function SettingsTab({
  spaceId,
  space,
  members,
  canGovern,
}: {
  spaceId: Id<"spaces">;
  space: SpaceDoc;
  members: MemberRow[];
  canGovern: boolean;
}) {
  return (
    <div className="space-y-6">
      <IdentityCard spaceId={spaceId} space={space} />
      <DefaultStatusesCard spaceId={spaceId} space={space} />
      <FeaturesCard spaceId={spaceId} space={space} />
      {space.parentType === "workspace" && (
        <PrivacyCard
          spaceId={spaceId}
          space={space}
          members={members}
          canGovern={canGovern}
        />
      )}
      <DangerCard spaceId={spaceId} space={space} />
    </div>
  );
}

function IdentityCard({
  spaceId,
  space,
}: {
  spaceId: Id<"spaces">;
  space: SpaceDoc;
}) {
  const update = useMutation(api.spaces.updateMeta);
  const { toast } = useToast();
  const [name, setName] = useState(space.name);
  const [description, setDescription] = useState(space.description ?? "");

  async function commit(patch: Record<string, unknown>, revert: () => void) {
    try {
      await update({ spaceId, ...patch });
      toast("Saved");
    } catch (e) {
      revert();
      toast(errorMessage(e, "Couldn't save"), { kind: "error" });
    }
  }

  return (
    <section className="rounded-2xl panel p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Identity
      </h2>

      <label className="mt-4 block text-xs font-medium text-muted-foreground">
        Name
        <input
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          onBlur={() => {
            const trimmed = name.trim();
            if (!trimmed || trimmed === space.name) {
              setName(space.name);
              return;
            }
            commit({ name: trimmed }, () => setName(space.name));
          }}
          className="soft-field mt-1 block w-full px-3 py-2 text-sm text-foreground focus:outline-none"
        />
      </label>

      <div className="mt-4">
        <p className="text-xs font-medium text-muted-foreground">Color</p>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {SWATCHES.map((hex) => (
            <button
              key={hex}
              type="button"
              aria-label={`Use ${hex}`}
              aria-pressed={(space.color ?? SWATCHES[0]) === hex}
              onClick={() => commit({ color: hex }, () => {})}
              style={{ backgroundColor: hex }}
              className={cn(
                "h-7 w-7 flex-shrink-0 rounded-full transition-transform",
                (space.color ?? SWATCHES[0]) === hex
                  ? "ring-2 ring-foreground ring-offset-2 ring-offset-background"
                  : "hover:scale-110",
              )}
            />
          ))}
        </div>
      </div>

      <label className="mt-4 block text-xs font-medium text-muted-foreground">
        Description
        <textarea
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          onBlur={() => {
            const trimmed = description.trim();
            if (trimmed === (space.description ?? "")) return;
            commit({ description: trimmed || null }, () =>
              setDescription(space.description ?? ""),
            );
          }}
          rows={2}
          placeholder="What is this Space for?"
          className="soft-field mt-1 block w-full resize-none px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
      </label>
    </section>
  );
}

function DefaultStatusesCard({
  spaceId,
  space,
}: {
  spaceId: Id<"spaces">;
  space: SpaceDoc;
}) {
  const update = useMutation(api.spaces.updateMeta);
  const { toast } = useToast();
  const statuses = (space.defaultStatuses ?? []) as DefaultStatus[];
  const [draftName, setDraftName] = useState("");
  const [draftCategory, setDraftCategory] = useState<StatusCategory>("open");

  async function save(next: DefaultStatus[] | null) {
    try {
      await update({ spaceId, defaultStatuses: next });
      toast("Saved");
    } catch (e) {
      toast(errorMessage(e, "Couldn't save statuses"), { kind: "error" });
    }
  }

  function removeAt(i: number) {
    save(statuses.filter((_, idx) => idx !== i));
  }

  async function addStatus() {
    const trimmed = draftName.trim();
    if (!trimmed) return;
    const color = SWATCHES[statuses.length % SWATCHES.length];
    await save([...statuses, { name: trimmed, color, category: draftCategory }]);
    setDraftName("");
    setDraftCategory("open");
  }

  return (
    <section className="rounded-2xl panel p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Default statuses
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        New lists in this Space start with these statuses instead of the
        defaults. Changes here only affect lists created after you save.
      </p>

      {space.defaultStatuses === undefined ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Using the standard four statuses.
        </p>
      ) : (
        <ul className="mt-4 space-y-1.5">
          {statuses.map((s, i) => (
            <li
              key={`${s.name}-${i}`}
              className="flex items-center gap-2 rounded-lg bg-muted px-3 py-1.5 text-sm"
            >
              <span
                aria-hidden
                className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full"
                style={{ backgroundColor: s.color }}
              />
              <span className="flex-1 truncate">{s.name}</span>
              <span className="flex-shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                {CATEGORY_LABEL[s.category]}
              </span>
              <button
                type="button"
                aria-label={`Remove ${s.name}`}
                onClick={() => removeAt(i)}
                className="flex-shrink-0 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          value={draftName}
          onChange={(e) => setDraftName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void addStatus();
            }
          }}
          placeholder="New status name"
          className="soft-field flex-1 px-3 py-1.5 text-sm focus:outline-none"
        />
        <select
          value={draftCategory}
          onChange={(e) =>
            setDraftCategory(e.currentTarget.value as StatusCategory)
          }
          className="soft-field px-3 py-1.5 text-xs focus:outline-none"
        >
          {(Object.keys(CATEGORY_LABEL) as StatusCategory[]).map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void addStatus()}
          disabled={!draftName.trim()}
          className="inline-flex h-9 flex-shrink-0 items-center justify-center gap-1 rounded-full bg-foreground px-3 text-sm font-medium text-background disabled:opacity-40"
        >
          <Plus className="h-4 w-4" /> Add
        </button>
      </div>

      {space.defaultStatuses !== undefined && (
        <button
          type="button"
          onClick={() => save(null)}
          className="mt-3 text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          Reset to defaults
        </button>
      )}
    </section>
  );
}

type SpaceFeatures = NonNullable<SpaceDoc["features"]>;
type FeatureKey = keyof SpaceFeatures;

const FEATURE_ROWS: { key: FeatureKey; label: string; description: string }[] = [
  { key: "sprints", label: "Sprints", description: "Timebox work into sprints." },
  { key: "goals", label: "Goals", description: "Set and measure goals." },
  {
    key: "whiteboards",
    label: "Whiteboards",
    description: "Collaborative whiteboards.",
  },
];

function FeaturesCard({
  spaceId,
  space,
}: {
  spaceId: Id<"spaces">;
  space: SpaceDoc;
}) {
  const update = useMutation(api.spaces.updateMeta);
  const { toast } = useToast();
  const features: SpaceFeatures = space.features ?? {};

  async function toggle(key: FeatureKey, checked: boolean) {
    try {
      await update({ spaceId, features: { ...features, [key]: checked } });
      toast("Saved");
    } catch (e) {
      toast(errorMessage(e, "Couldn't save features"), { kind: "error" });
    }
  }

  return (
    <section className="rounded-2xl panel p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Features
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Turning a feature off hides it for this Space. Nothing is deleted.
        {space.parentType === "workspace" &&
          " For Sprints and Goals, if every Space in the workspace turns the feature off, the workspace-level tab is hidden too."}
      </p>
      <ul className="mt-4 space-y-3">
        {FEATURE_ROWS.map((row) => (
          <li key={row.key} className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">{row.label}</p>
              <p className="text-xs text-muted-foreground">{row.description}</p>
            </div>
            <input
              type="checkbox"
              checked={features[row.key] !== false}
              onChange={(e) => toggle(row.key, e.currentTarget.checked)}
              aria-label={row.label}
              className="h-4 w-4 flex-shrink-0 accent-[var(--color-foreground)]"
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function PrivacyCard({
  spaceId,
  space,
  members,
  canGovern,
}: {
  spaceId: Id<"spaces">;
  space: SpaceDoc;
  members: MemberRow[];
  canGovern: boolean;
}) {
  const update = useMutation(api.spaces.updateMeta);
  const { toast } = useToast();
  const workspaceId = space.parentId as Id<"workspaces">;
  const workspaceMembers = useQuery(
    api.workspaces.listMembers,
    canGovern && space.private ? { workspaceId } : "skip",
  );

  async function setPrivate(next: boolean) {
    try {
      await update({ spaceId, private: next });
      toast("Saved");
    } catch (e) {
      toast(errorMessage(e, "Couldn't change privacy"), { kind: "error" });
    }
  }

  async function setMembers(ids: string[]) {
    try {
      await update({ spaceId, memberClerkIds: ids });
      toast("Saved");
    } catch (e) {
      toast(errorMessage(e, "Couldn't update members"), { kind: "error" });
    }
  }

  const addable = (workspaceMembers ?? [])
    .filter((u) => !members.some((m) => m.clerkId === u.clerkId))
    .map((u) => ({ id: u.clerkId, label: u.name || u.email || "Member" }));

  return (
    <section className="rounded-2xl panel p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Privacy
      </h2>

      <label className="mt-4 flex items-center gap-2.5 text-sm">
        <input
          type="checkbox"
          checked={!!space.private}
          disabled={!canGovern}
          onChange={(e) => setPrivate(e.currentTarget.checked)}
          className="h-4 w-4 accent-[var(--color-foreground)] disabled:opacity-50"
        />
        Private Space
      </label>

      {!canGovern && (
        <p className="mt-2 text-xs text-muted-foreground">
          Only the Space creator or workspace owner can change privacy.
        </p>
      )}

      {space.private && (
        <div className="mt-4 space-y-1.5">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Members
          </p>
          <ul className="space-y-1">
            {members.map((m) => (
              <li
                key={m.clerkId}
                className="flex items-center gap-2 rounded-lg bg-muted px-2.5 py-1.5 text-sm"
              >
                <Monogram name={m.name} size="sm" />
                <span className="min-w-0 flex-1 truncate">{m.name}</span>
                {canGovern && (
                  <button
                    type="button"
                    aria-label={`Remove ${m.name}`}
                    onClick={() =>
                      setMembers(
                        members
                          .filter((x) => x.clerkId !== m.clerkId)
                          .map((x) => x.clerkId),
                      )
                    }
                    className="flex-shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
          {canGovern && (
            <Picker
              label="+ Add member…"
              options={addable}
              onSelect={(id) => setMembers([...members.map((m) => m.clerkId), id])}
              dashed
              className="mt-2"
            />
          )}
        </div>
      )}
    </section>
  );
}

function DangerCard({
  spaceId,
  space,
}: {
  spaceId: Id<"spaces">;
  space: SpaceDoc;
}) {
  const update = useMutation(api.spaces.updateMeta);
  const { toast } = useToast();
  const archived = !!space.archivedAt;

  async function toggleArchive() {
    const next = !archived;
    try {
      await update({ spaceId, archived: next });
      if (next) {
        toast("Space archived", {
          action: {
            label: "Undo",
            onClick: () => {
              update({ spaceId, archived: false }).catch(() => {});
            },
          },
        });
      } else {
        toast("Space restored");
      }
    } catch (e) {
      toast(errorMessage(e, "Couldn't update Space"), { kind: "error" });
    }
  }

  return (
    <section className="rounded-2xl panel p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        Danger zone
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {archived
          ? "This Space is archived — it's hidden from the sidebar and Home, but this page stays reachable by URL and nothing inside it is deleted."
          : "Archiving hides this Space from the sidebar and Home. Nothing inside it is deleted, and this page stays reachable by URL."}
      </p>
      <button
        type="button"
        onClick={toggleArchive}
        className="mt-3 inline-flex h-9 items-center rounded-full bg-muted px-4 text-sm font-medium text-foreground hover:bg-border"
      >
        {archived ? "Unarchive Space" : "Archive Space"}
      </button>
    </section>
  );
}

// ── States ──────────────────────────────────────────────────────────────────

function PageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="h-8 w-1/3 animate-pulse rounded-full bg-muted" />
        <div className="h-4 w-1/2 animate-pulse rounded-full bg-muted" />
      </div>
      <div className="flex gap-1 rounded-full border border-border p-1">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="h-7 w-24 animate-pulse rounded-full bg-muted/60"
          />
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-40 animate-pulse rounded-2xl bg-muted/60" />
        ))}
      </div>
    </div>
  );
}
