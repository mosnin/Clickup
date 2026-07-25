"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { ChevronLeft, ChevronRight, LayoutTemplate, Search } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Picker, type PickerOption } from "@/components/ui/picker";
import { BorderBeam } from "@/components/ui/beam";
import { PageHeader } from "@/components/dashboard/page-header";
import { EmptyState } from "@/components/dashboard/empty-state";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import {
  AnimatePresence,
  EASE,
  Reveal,
  SPRING,
  motion,
} from "@/components/motion";

// Template Center: one surface for starting from a shape — lists, tasks,
// docs, whiteboards, and saved view presets. The catalog lives in
// convex/templateCatalog.ts; templates.applyCatalogTemplate materialises an
// entry through the product's real write paths.
//
// Presentation is deliberately not a flat grid. Templates ride a
// snap-scrolling carousel per category: the card nearest the centre of the
// track wears the border beam and scales up, the arrows and arrow keys move
// between cards, and filters re-flow the track with layout animations so
// cards travel to their new positions instead of popping. Each track owns
// its own horizontal overflow (overscroll-x-contain), so nothing widens the
// page at 360px. Every animation runs through the shared motion primitives,
// which collapse to a static, scrollable list under reduced motion.

type EntityType = "list" | "task" | "doc" | "whiteboard" | "view";
type Complexity = "beginner" | "intermediate" | "advanced";

type TemplateSummary = {
  slug: string;
  name: string;
  description: string;
  entityType: EntityType;
  category: string;
  useCases: string[];
  complexity: Complexity;
  stats: { label: string; value: number }[];
  sampleLabel: string;
  samples: string[];
  outcome: string;
};

const ENTITY_FILTERS = [
  { key: "all", label: "Everything" },
  { key: "list", label: "Lists" },
  { key: "task", label: "Tasks" },
  { key: "doc", label: "Docs" },
  { key: "whiteboard", label: "Boards" },
  { key: "view", label: "Views" },
] as const;
type EntityFilter = (typeof ENTITY_FILTERS)[number]["key"];

const COMPLEXITY_FILTERS = [
  { key: "all", label: "Any level" },
  { key: "beginner", label: "Beginner" },
  { key: "intermediate", label: "Intermediate" },
  { key: "advanced", label: "Advanced" },
] as const;
type ComplexityFilter = (typeof COMPLEXITY_FILTERS)[number]["key"];

const SORTS = [
  { key: "recommended", label: "Recommended" },
  { key: "az", label: "A–Z" },
  { key: "richest", label: "Most built out" },
  { key: "simplest", label: "Simplest first" },
] as const;
type SortKey = (typeof SORTS)[number]["key"];

const ENTITY_NOUN: Record<EntityType, string> = {
  list: "List",
  task: "Task",
  doc: "Doc",
  whiteboard: "Whiteboard",
  view: "Saved view",
};

const COMPLEXITY_RANK: Record<Complexity, number> = {
  beginner: 0,
  intermediate: 1,
  advanced: 2,
};

function contentWeight(t: TemplateSummary): number {
  return t.stats.reduce((n, s) => n + s.value, 0);
}

// Raised-white active pill on a recessed track — the app's segmented
// control, straight from globals.css.
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
          aria-selected={o.key === value}
          onClick={() => onChange(o.key)}
          className={cn("flex-shrink-0", o.key === value && "segmented-on")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function TemplateCenter() {
  const catalog = useQuery(api.templates.catalog, {});
  const tree = useQuery(api.sidebar.tree, {});

  const [search, setSearch] = useState("");
  const [entity, setEntity] = useState<EntityFilter>("all");
  const [complexity, setComplexity] = useState<ComplexityFilter>("all");
  const [sort, setSort] = useState<SortKey>("recommended");
  const [category, setCategory] = useState("all");
  const [useCase, setUseCase] = useState("all");
  const [chosen, setChosen] = useState<TemplateSummary | null>(null);
  // Only one shelf shows a beam at a time — emphasis loses its meaning if
  // every row glows. The shelf the person last touched owns it.
  const [activeShelf, setActiveShelf] = useState<string | null>(null);

  const templates: TemplateSummary[] = useMemo(
    () => (catalog?.templates ?? []) as TemplateSummary[],
    [catalog],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = templates.filter((t) => {
      if (entity !== "all" && t.entityType !== entity) return false;
      if (complexity !== "all" && t.complexity !== complexity) return false;
      if (category !== "all" && t.category !== category) return false;
      if (useCase !== "all" && !t.useCases.includes(useCase)) return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q) ||
        t.samples.some((s) => s.toLowerCase().includes(q)) ||
        t.useCases.some((u) => u.toLowerCase().includes(q))
      );
    });
    const sorted = [...filtered];
    if (sort === "az") sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "richest")
      sorted.sort((a, b) => contentWeight(b) - contentWeight(a));
    else if (sort === "simplest")
      sorted.sort(
        (a, b) =>
          COMPLEXITY_RANK[a.complexity] - COMPLEXITY_RANK[b.complexity] ||
          a.name.localeCompare(b.name),
      );
    return sorted;
  }, [templates, search, entity, complexity, category, useCase, sort]);

  // Shelves follow the catalog's own category order so the page keeps a
  // stable rhythm as filters narrow it.
  const shelves = useMemo(() => {
    const order: string[] = catalog?.categories ?? [];
    const byCategory = new Map<string, TemplateSummary[]>();
    for (const t of visible) {
      const bucket = byCategory.get(t.category);
      if (bucket) bucket.push(t);
      else byCategory.set(t.category, [t]);
    }
    return order
      .filter((c) => byCategory.has(c))
      .map((c) => ({ category: c, templates: byCategory.get(c) ?? [] }));
  }, [visible, catalog]);

  const useCaseOptions: PickerOption[] = useMemo(
    () => [
      { id: "all", label: "Any use case" },
      ...((catalog?.useCases ?? []) as string[]).map((u) => ({
        id: u,
        label: u,
      })),
    ],
    [catalog],
  );

  // If filtering removed the shelf that owned the beam, hand it to the
  // first shelf still on screen rather than leaving nothing emphasised.
  const beamedCategory = shelves.some((s) => s.category === activeShelf)
    ? activeShelf
    : shelves[0]?.category;

  const filtersApplied =
    search.trim() !== "" ||
    entity !== "all" ||
    complexity !== "all" ||
    category !== "all" ||
    useCase !== "all";

  function clearFilters() {
    setSearch("");
    setEntity("all");
    setComplexity("all");
    setCategory("all");
    setUseCase("all");
  }

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        icon={LayoutTemplate}
        title="Templates"
        context={
          catalog === undefined
            ? undefined
            : `${visible.length} of ${templates.length}`
        }
      />

      <AnimatePresence mode="wait" initial={false}>
        {chosen ? (
          <motion.div
            key="confirm"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.3, ease: EASE }}
            className="min-w-0"
          >
            <ConfirmStep
              template={chosen}
              tree={tree as Tree | undefined}
              onBack={() => setChosen(null)}
              onApplied={() => setChosen(null)}
            />
          </motion.div>
        ) : (
          <motion.div
            key="browse"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25, ease: EASE }}
            className="min-w-0 space-y-6"
          >
            <Reveal className="min-w-0">
              <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
                Start from a shape instead of a blank page. Every template
                creates real work in your workspace — a list with its statuses
                and starter tasks, a task with its acceptance criteria, a doc
                already structured, a board with its frames, or a saved view
                preset.
              </p>
            </Reveal>

            <div className="min-w-0 space-y-3">
              <label className="soft-field flex min-w-0 items-center gap-2 px-3.5 py-2.5">
                <Search
                  aria-hidden
                  className="h-4 w-4 flex-shrink-0 text-muted-foreground"
                />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.currentTarget.value)}
                  placeholder="Search templates — launch, postmortem, onboarding, retro…"
                  aria-label="Search templates"
                  className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
              </label>

              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Segmented
                  ariaLabel="Filter by what the template creates"
                  value={entity}
                  onChange={setEntity}
                  options={ENTITY_FILTERS}
                />
                <Segmented
                  ariaLabel="Filter by complexity"
                  value={complexity}
                  onChange={setComplexity}
                  options={COMPLEXITY_FILTERS}
                />
                <Segmented
                  ariaLabel="Sort templates"
                  value={sort}
                  onChange={setSort}
                  options={SORTS}
                />
                <Picker
                  options={useCaseOptions}
                  selectedId={useCase}
                  onSelect={setUseCase}
                  label={useCase === "all" ? "Any use case" : useCase}
                  dashed={useCase === "all"}
                />
                {filtersApplied && (
                  <Button variant="ghost" size="sm" onClick={clearFilters}>
                    Clear
                  </Button>
                )}
              </div>

              <div className="flex min-w-0 flex-wrap gap-1.5">
                {[
                  { key: "all", label: "All categories" },
                  ...((catalog?.categories ?? []) as string[]).map((c) => ({
                    key: c,
                    label: c,
                  })),
                ].map((c) => {
                  const on = c.key === category;
                  return (
                    <button
                      key={c.key}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setCategory(c.key)}
                      className={cn(
                        "tap-target rounded-full px-3 py-1 text-xs transition-colors",
                        on
                          ? "bg-foreground text-background"
                          : "bg-muted text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {catalog === undefined ? (
              <div className="space-y-6">
                {[0, 1].map((i) => (
                  <div key={i} className="space-y-3">
                    <div className="h-4 w-32 animate-pulse rounded-full bg-muted" />
                    <div className="flex gap-4 overflow-hidden">
                      {[0, 1, 2].map((j) => (
                        <div
                          key={j}
                          className="h-72 w-[20rem] flex-shrink-0 animate-pulse rounded-2xl bg-muted/50"
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : shelves.length === 0 ? (
              <EmptyState
                title="No templates match"
                message={`Nothing fits those filters yet. Clear them to browse all ${templates.length} templates.`}
                action={
                  <Button variant="outline" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <div className="min-w-0 space-y-8">
                {shelves.map((shelf, i) => (
                  <Shelf
                    key={shelf.category}
                    category={shelf.category}
                    templates={shelf.templates}
                    beamed={beamedCategory === shelf.category}
                    onActivate={() => setActiveShelf(shelf.category)}
                    onUse={(t) => setChosen(t)}
                    resetKey={`${search}|${entity}|${complexity}|${category}|${useCase}|${sort}`}
                    delay={Math.min(i, 4) * 0.05}
                  />
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── One category's carousel ─────────────────────────────────────────────

function Shelf({
  category,
  templates,
  beamed,
  onActivate,
  onUse,
  resetKey,
  delay,
}: {
  category: string;
  templates: TemplateSummary[];
  /** This shelf owns the app's single focused-card beam. */
  beamed: boolean;
  onActivate: () => void;
  onUse: (t: TemplateSummary) => void;
  /** Changing this (any filter or sort change) re-centres on the first card. */
  resetKey: string;
  delay: number;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(0);

  const scrollToIndex = useCallback((index: number) => {
    const track = trackRef.current;
    if (!track) return;
    const el = track.children[index] as HTMLElement | undefined;
    if (!el) return;
    const left = el.offsetLeft - (track.clientWidth - el.offsetWidth) / 2;
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    track.scrollTo({
      left: Math.max(0, left),
      behavior: reduced ? "auto" : "smooth",
    });
  }, []);

  // Nearest-to-centre card wins focus, recomputed on scroll — which makes
  // touch momentum and trackpad flicks feel native without a drag library.
  const syncActive = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const centre = track.scrollLeft + track.clientWidth / 2;
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < track.children.length; i++) {
      const el = track.children[i] as HTMLElement;
      const dist = Math.abs(el.offsetLeft + el.offsetWidth / 2 - centre);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    setActive(best);
  }, []);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    track.scrollTo({ left: 0, behavior: "auto" });
    setActive(0);
  }, [resetKey]);

  const atStart = active === 0;
  const atEnd = active >= templates.length - 1;

  return (
    <motion.section
      aria-label={`${category} templates`}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: EASE, delay }}
      onPointerEnter={onActivate}
      onFocusCapture={onActivate}
      className="min-w-0"
    >
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="min-w-0 truncate font-semibold tracking-tight">
          {category}
        </h2>
        <div className="flex items-center gap-2">
          <p className="text-xs tabular-nums text-muted-foreground">
            {active + 1} of {templates.length}
          </p>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label={`Previous ${category} template`}
              disabled={atStart}
              onClick={() => {
                onActivate();
                scrollToIndex(active - 1);
              }}
              className="tap-target inline-flex h-8 w-8 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label={`Next ${category} template`}
              disabled={atEnd}
              onClick={() => {
                onActivate();
                scrollToIndex(active + 1);
              }}
              className="tap-target inline-flex h-8 w-8 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      <div
        ref={trackRef}
        role="group"
        tabIndex={0}
        aria-label={`${category} template carousel — use the arrow keys to move between templates`}
        onScroll={syncActive}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") {
            e.preventDefault();
            scrollToIndex(Math.min(active + 1, templates.length - 1));
          } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            scrollToIndex(Math.max(active - 1, 0));
          } else if (e.key === "Home") {
            e.preventDefault();
            scrollToIndex(0);
          } else if (e.key === "End") {
            e.preventDefault();
            scrollToIndex(templates.length - 1);
          }
        }}
        className="mt-3 flex min-w-0 snap-x snap-mandatory gap-4 overflow-x-auto overscroll-x-contain rounded-2xl px-1 py-3 outline-none focus-visible:ring-2 focus-visible:ring-foreground/20"
      >
        <AnimatePresence initial={false} mode="popLayout">
          {templates.map((t, i) => (
            <motion.div
              key={t.slug}
              layout
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{
                opacity: i === active ? 1 : 0.72,
                scale: i === active ? 1 : 0.96,
              }}
              exit={{ opacity: 0, scale: 0.94 }}
              transition={SPRING}
              className="w-[20rem] max-w-[84vw] flex-shrink-0 snap-center"
            >
              <TemplateCard
                template={t}
                focused={beamed && i === active}
                onUse={() => onUse(t)}
                onFocusRequest={() => {
                  onActivate();
                  scrollToIndex(i);
                }}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </motion.section>
  );
}

// ── Card ────────────────────────────────────────────────────────────────

function TemplateCard({
  template,
  focused,
  onUse,
  onFocusRequest,
}: {
  template: TemplateSummary;
  focused: boolean;
  onUse: () => void;
  onFocusRequest: () => void;
}) {
  const card = (
    <div
      onFocusCapture={onFocusRequest}
      className={cn(
        "panel flex h-full min-w-0 flex-col rounded-2xl p-5",
        !focused && "lift",
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-foreground">
          {ENTITY_NOUN[template.entityType]}
        </span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          {template.complexity}
        </span>
      </div>

      <p className="mt-3 font-semibold tracking-tight">{template.name}</p>
      <p className="mt-1.5 line-clamp-3 text-sm leading-relaxed text-muted-foreground">
        {template.description}
      </p>

      <dl className="mt-4 grid grid-cols-3 gap-2">
        {template.stats.map((stat) => (
          <div key={stat.label} className="bento-tile min-w-0 px-2.5 py-2">
            <dt className="truncate text-[10px] uppercase tracking-wider text-muted-foreground">
              {stat.label}
            </dt>
            <dd className="text-sm font-semibold tabular-nums">{stat.value}</dd>
          </div>
        ))}
      </dl>

      {template.samples.length > 0 && (
        <div className="mt-4 min-w-0">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {template.sampleLabel}
          </p>
          <ul className="mt-1.5 space-y-1">
            {template.samples.map((sample, i) => (
              <li
                key={`${sample}-${i}`}
                className="truncate text-xs text-muted-foreground"
              >
                {sample}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 flex min-w-0 flex-wrap gap-1">
        {template.useCases.slice(0, 3).map((u) => (
          <span
            key={u}
            className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
          >
            {u}
          </span>
        ))}
      </div>

      <div className="mt-auto flex items-center gap-3 pt-5">
        <Button size="sm" onClick={onUse}>
          Use template
        </Button>
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {template.outcome}
        </span>
      </div>
    </div>
  );

  // The beam is emphasis, not decoration: only the focused card wears it,
  // and only on the shelf the person is actually using.
  return focused ? (
    <BorderBeam size="md" colorVariant="colorful" className="flex h-full">
      {card}
    </BorderBeam>
  ) : (
    card
  );
}

// ── Confirm destination ─────────────────────────────────────────────────

type SpaceNode = {
  _id: Id<"spaces">;
  name: string;
  folders: { _id: Id<"folders">; name: string; lists: { _id: Id<"lists">; name: string }[] }[];
  lists: { _id: Id<"lists">; name: string }[];
};

type Tree = {
  personal: SpaceNode | null;
  workspaces: { _id: Id<"workspaces">; name: string; spaces: SpaceNode[] }[];
} | null;

// Destination ids are prefixed so one Picker can offer spaces, folders, and
// lists without a second control: "space:<id>", "folder:<id>", "list:<id>".
function destinationOptions(
  tree: Tree | undefined,
  entityType: EntityType,
): PickerOption[] {
  if (!tree) return [];
  const wantsList = entityType === "task" || entityType === "view";
  const wantsFolder = entityType === "list";
  const out: PickerOption[] = [];

  const walk = (space: SpaceNode, scope: string) => {
    if (!wantsList) {
      out.push({ id: `space:${space._id}`, label: space.name, hint: scope });
    }
    for (const list of space.lists) {
      if (wantsList) {
        out.push({
          id: `list:${list._id}`,
          label: list.name,
          hint: space.name,
        });
      }
    }
    for (const folder of space.folders) {
      if (wantsFolder) {
        out.push({
          id: `folder:${folder._id}`,
          label: `${space.name} / ${folder.name}`,
          hint: scope,
        });
      }
      for (const list of folder.lists) {
        if (wantsList) {
          out.push({
            id: `list:${list._id}`,
            label: list.name,
            hint: `${space.name} / ${folder.name}`,
          });
        }
      }
    }
  };

  if (tree.personal) walk(tree.personal, "Personal");
  for (const ws of tree.workspaces) {
    for (const space of ws.spaces) walk(space, ws.name);
  }
  return out;
}

function ConfirmStep({
  template,
  tree,
  onBack,
  onApplied,
}: {
  template: TemplateSummary;
  /** `api.sidebar.tree` — undefined while the subscription is loading. */
  tree: Tree | undefined;
  onBack: () => void;
  onApplied: () => void;
}) {
  const apply = useMutation(api.templates.applyCatalogTemplate);
  const { toast } = useToast();
  const router = useRouter();
  const [destination, setDestination] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const options = useMemo(
    () => destinationOptions(tree, template.entityType),
    [tree, template.entityType],
  );

  const selected = options.find((o) => o.id === destination);
  const loading = tree === undefined;

  const destinationNoun =
    template.entityType === "task" || template.entityType === "view"
      ? "list"
      : template.entityType === "list"
        ? "space or folder"
        : "space";

  const destinationHelp =
    template.entityType === "task"
      ? "This template creates one task inside the list you choose."
      : template.entityType === "view"
        ? "This template adds a saved view to the list you choose."
        : template.entityType === "list"
          ? "This template creates a new list inside the space or folder you choose."
          : template.entityType === "doc"
            ? "This template creates a new doc inside the space you choose."
            : "This template creates a new whiteboard inside the space you choose.";

  async function run() {
    if (!destination) return;
    const [kind, id] = destination.split(":");
    setBusy(true);
    try {
      const result = await apply({
        slug: template.slug,
        name: name.trim() || undefined,
        destinationType: kind as "space" | "folder" | "list",
        destinationId: id,
      });
      toast(`${result.name} created`, {
        action: { label: "Open", onClick: () => router.push(result.href) },
      });
      onApplied();
    } catch (e) {
      toast(errorMessage(e, "Couldn't apply that template"), {
        kind: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel min-w-0 space-y-5 rounded-2xl p-5 sm:p-6">
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {ENTITY_NOUN[template.entityType]} template
        </p>
        <h2 className="mt-1 text-lg font-semibold tracking-tight">
          {template.name}
        </h2>
        <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-muted-foreground">
          {template.outcome} {template.description}
        </p>
      </div>

      <dl className="grid max-w-md grid-cols-3 gap-2">
        {template.stats.map((stat) => (
          <div key={stat.label} className="bento-tile min-w-0 px-3 py-2">
            <dt className="truncate text-[10px] uppercase tracking-wider text-muted-foreground">
              {stat.label}
            </dt>
            <dd className="text-sm font-semibold tabular-nums">{stat.value}</dd>
          </div>
        ))}
      </dl>

      <div className="min-w-0 space-y-4">
        <div className="min-w-0 space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Create in
          </p>
          <p className="text-xs text-muted-foreground">{destinationHelp}</p>
          {loading ? (
            <div className="h-9 w-48 animate-pulse rounded-full bg-muted" />
          ) : options.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              You need a {destinationNoun} first — create one from the sidebar,
              then come back.
            </p>
          ) : (
            <Picker
              options={options}
              selectedId={destination ?? undefined}
              onSelect={setDestination}
              label={selected ? selected.label : `Choose a ${destinationNoun}…`}
              dashed={!selected}
            />
          )}
        </div>

        <div className="min-w-0 space-y-1.5">
          <label
            htmlFor="template-name"
            className="block text-[10px] uppercase tracking-wider text-muted-foreground"
          >
            Name
          </label>
          <input
            id="template-name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && destination && !busy) void run();
            }}
            placeholder={`Leave empty to use "${template.name}"`}
            className="soft-field w-full max-w-md px-3.5 py-2.5 text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={!destination || busy}
          onClick={() => void run()}
        >
          {busy ? "Creating…" : "Create it"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onBack} disabled={busy}>
          Back to templates
        </Button>
      </div>
    </section>
  );
}
