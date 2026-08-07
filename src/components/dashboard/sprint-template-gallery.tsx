"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Picker } from "@/components/ui/picker";
import { cn } from "@/lib/utils";
import { fromDateInputValue, toDateInputValue } from "@/lib/dates";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import {
  AnimatePresence,
  EASE,
  SPRING,
  motion,
} from "@/components/motion";

// Sprint template gallery: the "start from a shape" surface for the
// Sprints tab. The catalog lives in convex/sprintTemplates.ts and is
// applied by sprints.applyTemplate, which creates the timebox and
// materializes its ceremonies + starter tasks in one transaction.
//
// Presentation is a snap-scrolling carousel rather than a flat grid: the
// focused card scales up and carries the border beam, filters re-order the
// track with layout animations instead of a hard re-render, and the track
// owns its own horizontal overflow (overscroll-x-contain) so it never
// drags the page sideways on a 360px screen. Every motion here runs
// through the shared primitives, so prefers-reduced-motion collapses it to
// a plain scrollable row.

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const SORTS = [
  { key: "recommended", label: "Recommended" },
  { key: "shortest", label: "Shortest" },
  { key: "longest", label: "Longest" },
  { key: "az", label: "A–Z" },
] as const;
type SortKey = (typeof SORTS)[number]["key"];

const COMPLEXITIES = [
  { key: "all", label: "Any level" },
  { key: "beginner", label: "Beginner" },
  { key: "intermediate", label: "Intermediate" },
  { key: "advanced", label: "Advanced" },
] as const;
type ComplexityKey = (typeof COMPLEXITIES)[number]["key"];

type TemplateSummary = {
  slug: string;
  name: string;
  description: string;
  category: string;
  useCases: string[];
  complexity: "beginner" | "intermediate" | "advanced";
  lengthDays: number;
  goalTemplate: string;
  capacityPoints?: number;
  ceremonyCount: number;
  taskCount: number;
  totalPoints: number;
};

// Raised-white active pill on a soft track — the app's segmented control.
function Segmented<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  idPrefix,
}: {
  value: T;
  onChange: (next: T) => void;
  options: readonly { key: T; label: string }[];
  ariaLabel: string;
  /** Unique per control: keeps each control's morphing pill to itself. */
  idPrefix: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="inline-flex min-w-0 max-w-full items-center gap-1 overflow-x-auto overscroll-x-contain rounded-full bg-muted p-1"
    >
      {options.map((o) => {
        const on = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.key)}
            className={cn(
              "relative flex-shrink-0 rounded-full px-3 py-1.5 text-xs transition-colors",
              on ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {on && (
              <motion.span
                layoutId={`segmented-${idPrefix}`}
                transition={SPRING}
                className="absolute inset-0 rounded-full bg-background shadow-sm"
              />
            )}
            <span className={cn("relative", on && "font-medium")}>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function SprintTemplateGallery({
  workspaceId,
  onClose,
}: {
  workspaceId: Id<"workspaces">;
  onClose: () => void;
}) {
  const catalog = useQuery(api.sprints.templateCatalog, {});
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [complexity, setComplexity] = useState<ComplexityKey>("all");
  const [sort, setSort] = useState<SortKey>("recommended");
  const [chosen, setChosen] = useState<TemplateSummary | null>(null);

  const templates: TemplateSummary[] = useMemo(
    () => catalog?.templates ?? [],
    [catalog],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = templates.filter((t) => {
      if (category !== "all" && t.category !== category) return false;
      if (complexity !== "all" && t.complexity !== complexity) return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q) ||
        t.useCases.some((u) => u.toLowerCase().includes(q))
      );
    });
    const sorted = [...filtered];
    if (sort === "shortest") sorted.sort((a, b) => a.lengthDays - b.lengthDays);
    else if (sort === "longest") sorted.sort((a, b) => b.lengthDays - a.lengthDays);
    else if (sort === "az") sorted.sort((a, b) => a.name.localeCompare(b.name));
    return sorted;
  }, [templates, search, category, complexity, sort]);

  const categoryOptions = useMemo(
    () => [
      { key: "all", label: "All" },
      ...(catalog?.categories ?? []).map((c: string) => ({ key: c, label: c })),
    ],
    [catalog],
  );

  return (
    <section
      aria-label="Sprint templates"
      className="panel min-w-0 space-y-4 rounded-2xl p-4 sm:p-5"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold tracking-tight">Start from a template</h3>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            Each template creates the timebox plus its ceremonies and starter
            tasks — planning, standups, demo, retro, and the work that sprint
            always needs.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {chosen ? (
          <motion.div
            key="confirm"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.3, ease: EASE }}
          >
            <ConfirmStep
              template={chosen}
              workspaceId={workspaceId}
              onBack={() => setChosen(null)}
              onDone={onClose}
            />
          </motion.div>
        ) : (
          <motion.div
            key="gallery"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25, ease: EASE }}
            className="min-w-0 space-y-4"
          >
            <div className="min-w-0 space-y-3">
              <label className="soft-field flex min-w-0 items-center gap-2 px-3.5 py-2.5">
                <Search
                  aria-hidden
                  className="h-4 w-4 flex-shrink-0 text-muted-foreground"
                />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.currentTarget.value)}
                  placeholder="Search templates — launch, retro, migration, research…"
                  className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
              </label>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Segmented
                  idPrefix="complexity"
                  ariaLabel="Filter by complexity"
                  value={complexity}
                  onChange={setComplexity}
                  options={COMPLEXITIES}
                />
                <Segmented
                  idPrefix="sort"
                  ariaLabel="Sort templates"
                  value={sort}
                  onChange={setSort}
                  options={SORTS}
                />
              </div>
              <div className="flex min-w-0 flex-wrap gap-1.5">
                {categoryOptions.map((c) => {
                  const on = c.key === category;
                  return (
                    <button
                      key={c.key}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setCategory(c.key)}
                      className={cn(
                        "rounded-full px-3 py-1 text-xs transition-colors",
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
              <div className="h-56 animate-pulse rounded-2xl bg-muted/40" />
            ) : visible.length === 0 ? (
              <div className="rounded-2xl bento-tile px-6 py-12 text-center">
                <p className="text-sm font-semibold">No templates match</p>
                <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">
                  Try a different category, or clear the search to see all{" "}
                  {templates.length} sprint shapes.
                </p>
              </div>
            ) : (
              <Carousel
                templates={visible}
                onUse={(t) => setChosen(t)}
                resetKey={`${search}|${category}|${complexity}|${sort}`}
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

// ── Carousel ────────────────────────────────────────────────────────────

function Carousel({
  templates,
  onUse,
  resetKey,
}: {
  templates: TemplateSummary[];
  onUse: (t: TemplateSummary) => void;
  /** Changing this (a filter/sort change) re-centres on the first card. */
  resetKey: string;
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
    track.scrollTo({ left: Math.max(0, left), behavior: reduced ? "auto" : "smooth" });
  }, []);

  // Nearest-to-centre card wins focus; recomputed on scroll (rAF-throttled
  // by the browser's scroll event coalescing, which is cheap enough here).
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
    <div className="min-w-0">
      <div
        ref={trackRef}
        role="group"
        tabIndex={0}
        aria-label="Sprint template carousel — use the arrow keys to move between templates"
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
        className="relative flex min-w-0 snap-x snap-mandatory gap-4 overflow-x-auto overscroll-x-contain rounded-2xl px-1 py-3 outline-none focus-visible:ring-2 focus-visible:ring-foreground/20"
      >
        <AnimatePresence initial={false} mode="popLayout">
          {templates.map((t, i) => (
            <motion.div
              key={t.slug}
              layout
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{
                opacity: i === active ? 1 : 0.75,
                scale: i === active ? 1 : 0.965,
              }}
              exit={{ opacity: 0, scale: 0.94 }}
              transition={SPRING}
              className="w-[19rem] max-w-[84vw] flex-shrink-0 snap-center"
            >
              <TemplateCard
                template={t}
                focused={i === active}
                onUse={() => onUse(t)}
                onFocusRequest={() => scrollToIndex(i)}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <div className="mt-2 flex min-w-0 flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {templates.length} template{templates.length === 1 ? "" : "s"} ·{" "}
          {active + 1} of {templates.length}
        </p>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-label="Previous template"
            disabled={atStart}
            onClick={() => scrollToIndex(active - 1)}
            className="tap-target inline-flex h-8 w-8 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="Next template"
            disabled={atEnd}
            onClick={() => scrollToIndex(active + 1)}
            className="tap-target inline-flex h-8 w-8 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

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
        <span className="rounded-full bg-muted px-2 py-0.5 text-micro uppercase tracking-wider text-muted-foreground">
          {template.category}
        </span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-micro uppercase tracking-wider text-muted-foreground">
          {template.complexity}
        </span>
      </div>
      <p className="mt-3 font-semibold tracking-tight">{template.name}</p>
      <p className="mt-1.5 line-clamp-3 text-sm leading-relaxed text-muted-foreground">
        {template.description}
      </p>
      <dl className="mt-4 grid grid-cols-3 gap-2">
        {[
          { label: "Days", value: template.lengthDays },
          { label: "Ceremonies", value: template.ceremonyCount },
          { label: "Tasks", value: template.taskCount },
        ].map((stat) => (
          <div key={stat.label} className="bento-tile min-w-0 px-2.5 py-2">
            <dt className="text-micro uppercase tracking-wider text-muted-foreground">
              {stat.label}
            </dt>
            <dd className="text-sm font-semibold tabular-nums">{stat.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
        {template.goalTemplate}
      </p>
      <div className="mt-4 flex items-center gap-2 pt-1">
        <Button size="sm" onClick={onUse}>
          Use template
        </Button>
        {template.capacityPoints !== undefined && (
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {template.capacityPoints} pt capacity
          </span>
        )}
      </div>
    </div>
  );

  // Emphasis is the accent ring — the same lime that marks "current"
  // everywhere else; a rainbow border was its own color system.
  return focused ? (
    <div className="flex h-full rounded-2xl ring-2 ring-signal-lime">{card}</div>
  ) : (
    card
  );
}

// ── Confirm step ────────────────────────────────────────────────────────

function ConfirmStep({
  template,
  workspaceId,
  onBack,
  onDone,
}: {
  template: TemplateSummary;
  workspaceId: Id<"workspaces">;
  onBack: () => void;
  onDone: () => void;
}) {
  const applyTemplate = useMutation(api.sprints.applyTemplate);
  const tree = useQuery(api.sidebar.tree, {});
  const { toast } = useToast();
  const [name, setName] = useState(template.name);
  const [start, setStart] = useState(() => toDateInputValue(Date.now()));
  const [listId, setListId] = useState<Id<"lists"> | null>(null);
  const [pending, setPending] = useState(false);

  const listOptions = useMemo(() => {
    const ws = tree?.workspaces.find((w) => w._id === workspaceId);
    if (!ws) return [];
    const out: { id: string; label: string; hint?: string }[] = [];
    for (const space of ws.spaces) {
      for (const l of space.lists) {
        out.push({ id: l._id, label: l.name, hint: space.name });
      }
      for (const project of space.projects) {
        for (const l of project.lists) {
          out.push({ id: l._id, label: l.name, hint: project.name });
        }
      }
    }
    return out;
  }, [tree, workspaceId]);

  // Default to the first available list so the common path is one click.
  useEffect(() => {
    if (listId === null && listOptions.length > 0) {
      setListId(listOptions[0].id as Id<"lists">);
    }
  }, [listOptions, listId]);

  const startMs = fromDateInputValue(start) ?? Date.now();
  const endMs = startMs + template.lengthDays * ONE_DAY_MS;
  const fmt = (ts: number) =>
    new Date(ts).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  const selectedList = listOptions.find((o) => o.id === listId);
  const taskTotal = template.ceremonyCount + template.taskCount;

  return (
    <div className="min-w-0 space-y-4">
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {template.category} · {template.complexity}
        </p>
        <h4 className="mt-1 font-semibold tracking-tight">{template.name}</h4>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          {template.description}
        </p>
      </div>

      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className="block min-w-0">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Sprint name
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            autoFocus
            className="soft-field w-full min-w-0 px-3.5 py-2.5 text-sm outline-none"
          />
        </label>
        <label className="block min-w-0">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Starts
          </span>
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.currentTarget.value)}
            className="soft-field w-full min-w-0 px-3.5 py-2.5 text-sm outline-none"
          />
        </label>
      </div>

      <div className="min-w-0">
        <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Destination list
        </span>
        <Picker
          label={selectedList ? selectedList.label : "Choose a list…"}
          dashed={!selectedList}
          selectedId={listId ?? undefined}
          options={listOptions}
          onSelect={(id) => setListId(id as Id<"lists">)}
          className="max-w-full"
        />
        <p className="mt-1.5 text-xs text-muted-foreground">
          {selectedList
            ? `${taskTotal} tasks (${template.ceremonyCount} ceremonies, ${template.taskCount} starter tasks) land in ${selectedList.label}.`
            : listOptions.length === 0
              ? "This workspace has no lists yet — the sprint will be created empty."
              : "Without a list, only the timebox is created."}
        </p>
      </div>

      <div className="bento-tile min-w-0 px-4 py-3 text-sm">
        <p className="font-medium">
          {fmt(startMs)} – {fmt(endMs)} · {template.lengthDays} days
        </p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Goal: {template.goalTemplate}
        </p>
      </div>

      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={pending || !name.trim()}
          onClick={async () => {
            setPending(true);
            try {
              const result = await applyTemplate({
                workspaceId,
                slug: template.slug,
                startDate: startMs,
                listId: listId ?? undefined,
                name: name.trim(),
              });
              toast(
                result.taskIds.length > 0
                  ? `${name.trim()} created with ${result.taskIds.length} tasks`
                  : `${name.trim()} created`,
              );
              onDone();
            } catch (err) {
              toast(errorMessage(err, "Couldn't create the sprint"), {
                kind: "error",
              });
            } finally {
              setPending(false);
            }
          }}
        >
          {pending ? "Creating…" : "Create sprint"}
        </Button>
      </div>
    </div>
  );
}
