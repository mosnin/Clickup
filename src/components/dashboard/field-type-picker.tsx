"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Stagger, StaggerItem } from "@/components/motion";
import {
  FIELD_GROUPS,
  FIELD_TYPES,
  formatMoney,
  type FieldGroup,
  type FieldType,
  type FieldTypeMeta,
} from "@/lib/custom-fields";

// The field-type picker: our answer to the flat icon list every other tool
// ships. Types are grouped, searchable, and each one is a bento tile
// carrying a *live miniature* of the thing it makes — a rating shows stars,
// money shows a formatted amount, progress shows a filled bar. You choose a
// field by recognising it, not by reading its name.
//
// The chosen tile wears the lime accent ring so the selection reads
// as a deliberate, singular moment rather than another blue outline.

export function FieldTypePicker({
  value,
  onChange,
  className,
}: {
  value: FieldType | null;
  onChange: (type: FieldType) => void;
  className?: string;
}) {
  const [group, setGroup] = useState<FieldGroup | "all">("all");
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return FIELD_TYPES.filter((meta) => {
      if (q) {
        const hay = [meta.label, meta.blurb, ...meta.keywords]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      } else if (group !== "all" && meta.group !== group) {
        return false;
      }
      return true;
    });
  }, [group, query]);

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="soft-field flex min-w-0 flex-1 items-center gap-2 px-3 py-2">
          <Search
            aria-hidden
            className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="Search field types…"
            aria-label="Search field types"
            className="w-full min-w-0 bg-transparent text-sm focus:outline-none"
          />
        </label>
      </div>

      {/* Group switcher. The track scrolls on its own below sm so five
          groups never widen the page. */}
      <div className="-mx-1 overflow-x-auto overscroll-x-contain px-1 pb-1">
        <div className="segmented w-max">
          <button
            type="button"
            onClick={() => {
              setGroup("all");
              setQuery("");
            }}
            className={cn(query === "" && group === "all" && "segmented-on")}
          >
            All
          </button>
          {FIELD_GROUPS.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => {
                setGroup(g.id);
                setQuery("");
              }}
              className={cn(query === "" && group === g.id && "segmented-on")}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>

      {matches.length === 0 ? (
        <p className="bento-tile p-6 text-center text-sm text-muted-foreground">
          No field type matches “{query}”.
        </p>
      ) : (
        <Stagger
          key={`${group}-${query}`}
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
        >
          {matches.map((meta) => (
            <StaggerItem key={meta.type} className="min-w-0">
              <FieldTypeTile
                meta={meta}
                selected={value === meta.type}
                onSelect={() => onChange(meta.type)}
              />
            </StaggerItem>
          ))}
        </Stagger>
      )}
    </div>
  );
}

function FieldTypeTile({
  meta,
  selected,
  onSelect,
}: {
  meta: FieldTypeMeta;
  selected: boolean;
  onSelect: () => void;
}) {
  const tile = (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "bento lift flex h-full w-full min-w-0 flex-col gap-2 rounded-2xl bg-card p-4 text-left",
        selected && "bg-card",
      )}
    >
      <span className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="truncate text-sm font-semibold">{meta.label}</span>
        <span className="flex-shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
          {meta.group}
        </span>
      </span>
      <span className="text-xs leading-relaxed text-muted-foreground">
        {meta.blurb}
      </span>
      <span className="bento-tile mt-auto flex min-h-11 min-w-0 items-center overflow-hidden px-3 py-2">
        <FieldMiniature type={meta.type} />
      </span>
    </button>
  );

  if (!selected) return tile;
  return (
    <div className="flex h-full rounded-2xl ring-2 ring-signal-lime">{tile}</div>
  );
}

// ── Miniatures ─────────────────────────────────────────────────────────
// Each one is the real thing at rest: what the field looks like in a row
// once it holds a value. Static, non-interactive, and cheap — this grid
// renders twenty of them at once.

function Chip({
  children,
  color,
}: {
  children: React.ReactNode;
  color?: string;
}) {
  return (
    <span
      className="inline-flex max-w-full items-center truncate rounded-full px-2 py-0.5 text-[11px] text-foreground"
      style={{ backgroundColor: color ?? "var(--color-background)" }}
    >
      {children}
    </span>
  );
}

function MiniStars({ filled, total }: { filled: number; total: number }) {
  return (
    <span aria-hidden className="flex items-center gap-0.5">
      {Array.from({ length: total }, (_, i) => (
        <svg
          key={i}
          viewBox="0 0 20 20"
          className={cn(
            "h-3.5 w-3.5",
            i < filled ? "text-foreground" : "text-muted-foreground/35",
          )}
          fill="currentColor"
        >
          <path d="M10 1.6l2.47 5.29 5.53.74-4.06 3.9 1.02 5.67L10 14.5l-4.96 2.7 1.02-5.67L2 7.63l5.53-.74z" />
        </svg>
      ))}
    </span>
  );
}

function FieldMiniature({ type }: { type: FieldType }) {
  switch (type) {
    case "text":
      return (
        <span className="truncate text-xs text-foreground">Acme Corp</span>
      );
    case "long_text":
      return (
        <span className="flex w-full min-w-0 flex-col gap-1" aria-hidden>
          <span className="h-1.5 w-full rounded-full bg-foreground/20" />
          <span className="h-1.5 w-4/5 rounded-full bg-foreground/15" />
          <span className="h-1.5 w-3/5 rounded-full bg-foreground/10" />
        </span>
      );
    case "dropdown":
      return <Chip color="var(--color-pastel-blue)">In review</Chip>;
    case "labels":
      return (
        <span className="flex min-w-0 flex-wrap items-center gap-1">
          <Chip color="var(--color-pastel-purple)">design</Chip>
          <Chip color="var(--color-pastel-green)">api</Chip>
          <Chip color="var(--color-pastel-yellow)">p0</Chip>
        </span>
      );
    case "date":
      return (
        <span className="truncate text-xs tabular-nums text-foreground">
          Mar 14, 2026
        </span>
      );
    case "checkbox":
      return (
        <span className="flex items-center gap-2">
          <span
            aria-hidden
            className="grid h-4 w-4 place-items-center rounded border border-foreground bg-foreground"
          >
            <svg viewBox="0 0 16 16" className="h-3 w-3 text-background">
              <path
                d="M3.5 8.5l3 3 6-7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="text-xs text-muted-foreground">Signed off</span>
        </span>
      );
    case "files":
      return (
        <span className="flex min-w-0 items-center gap-1">
          <Chip>brief.pdf</Chip>
          <Chip>hero.png</Chip>
        </span>
      );
    case "number":
      return (
        <span className="text-xs tabular-nums text-foreground">1,248</span>
      );
    case "money":
      return (
        <span className="text-xs font-medium tabular-nums text-foreground">
          {formatMoney(12500, "USD")}
        </span>
      );
    case "rating":
      return <MiniStars filled={4} total={5} />;
    case "progress":
      return (
        <span className="flex w-full min-w-0 items-center gap-2">
          <span
            aria-hidden
            className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-foreground/10"
          >
            <span className="block h-full w-[68%] rounded-full bg-foreground" />
          </span>
          <span className="flex-shrink-0 text-[11px] tabular-nums text-muted-foreground">
            68%
          </span>
        </span>
      );
    case "voting":
      return (
        <span className="flex items-center gap-2">
          <span className="rounded-full bg-background px-2 py-0.5 text-[11px] tabular-nums">
            ▲ 12
          </span>
          <span className="text-[11px] text-muted-foreground">upvotes</span>
        </span>
      );
    case "email":
      return (
        <span className="truncate text-xs text-foreground underline decoration-foreground/25 underline-offset-2">
          dana@acme.com
        </span>
      );
    case "phone":
      return (
        <span className="truncate text-xs tabular-nums text-foreground">
          +1 415 555 0142
        </span>
      );
    case "url":
      return (
        <span className="truncate text-xs text-foreground underline decoration-foreground/25 underline-offset-2">
          acme.com/launch
        </span>
      );
    case "location":
      return (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-xs text-foreground">
            Lisbon, Portugal
          </span>
          <span className="truncate text-[10px] tabular-nums text-muted-foreground">
            38.7223, −9.1393
          </span>
        </span>
      );
    case "people":
      return (
        <span className="flex min-w-0 items-center gap-1">
          <Chip color="var(--color-pastel-blue)">Dana</Chip>
          <Chip color="var(--color-pastel-pink)">Scout</Chip>
        </span>
      );
    case "relationship":
      return (
        <span className="flex min-w-0 items-center gap-1">
          <Chip>Auth epic</Chip>
          <span className="flex-shrink-0 text-[11px] text-muted-foreground">
            +2
          </span>
        </span>
      );
    case "rollup":
      return (
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="text-xs font-medium tabular-nums text-foreground">
            34
          </span>
          <span className="truncate text-[10px] uppercase tracking-wider text-muted-foreground">
            sum of subtasks
          </span>
        </span>
      );
    case "formula":
      return (
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="text-xs font-medium tabular-nums text-foreground">
            2,400
          </span>
          <span className="truncate font-mono text-[10px] text-muted-foreground">
            {"{Hours} × {Rate}"}
          </span>
        </span>
      );
  }
}
