"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { Lock, Search } from "lucide-react";
import { api } from "@convex/_generated/api";
import { Stagger, StaggerItem } from "@/components/motion";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/dashboard/page-header";
import { EmptyState } from "@/components/dashboard/empty-state";
import { cn } from "@/lib/utils";

// Global search: one text box, four buckets (tasks/projects/docs/spaces),
// all access-checked server-side by convex/search.ts. The query text lives
// in ?q= so a search is shareable, but typing itself is debounced 250ms
// before it ever reaches Convex or the URL.

type Results = NonNullable<ReturnType<typeof useQuery<typeof api.search.everything>>>;

const STATUS_CHIP: Record<
  NonNullable<Results["lists"][number]["projectStatus"]>,
  { label: string; className: string }
> = {
  on_track: { label: "On track", className: "bg-pastel-green" },
  at_risk: { label: "At risk", className: "bg-pastel-yellow" },
  off_track: { label: "Off track", className: "bg-pastel-red" },
  paused: { label: "Paused", className: "bg-muted" },
};

export function SearchView({ initialQuery }: { initialQuery: string }) {
  const router = useRouter();
  const [raw, setRaw] = useState(initialQuery);
  const [debounced, setDebounced] = useState(initialQuery.trim());
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(raw.trim()), 250);
    return () => clearTimeout(t);
  }, [raw]);

  useEffect(() => {
    const target = debounced
      ? `/dashboard/search?q=${encodeURIComponent(debounced)}`
      : "/dashboard/search";
    router.replace(target, { scroll: false });
  }, [debounced, router]);

  const active = debounced.length >= 2;
  const results = useQuery(api.search.everything, active ? { text: debounced } : "skip");

  const total = results
    ? results.tasks.length + results.docs.length + results.lists.length + results.spaces.length
    : 0;

  return (
    <div className="space-y-8">
      <PageHeader
        icon={Search}
        title="Search"
        context={
          active && results !== undefined
            ? `${total} result${total === 1 ? "" : "s"}`
            : undefined
        }
      >
        <div className="relative pb-3 pt-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            ref={inputRef}
            autoFocus
            value={raw}
            onChange={(e) => setRaw(e.currentTarget.value)}
            placeholder="Search everything…"
            className="pl-9"
          />
        </div>
      </PageHeader>

      {!active ? (
        <EmptyState
          title="Search across your workspace"
          message="Type at least two characters to look up task titles, project (list) names, docs, and spaces you have access to."
        />
      ) : results === undefined ? (
        <SearchSkeleton />
      ) : total === 0 ? (
        <EmptyState title="No matches" message={`Nothing matches "${debounced}".`} />
      ) : (
        <div className="space-y-8">
          <ResultSection title="Tasks">
            {results.tasks.map((t) => (
              <StaggerItem key={t.taskId}>
                <Link
                  href={`/dashboard/l/${t.listId}/t/${t.taskId}`}
                  className="lift flex items-center justify-between gap-3 rounded-2xl panel px-4 py-3"
                >
                  <span className="min-w-0 truncate text-sm font-medium">{t.title}</span>
                  <span className="flex-shrink-0 truncate text-xs text-muted-foreground">
                    {t.listName}
                  </span>
                </Link>
              </StaggerItem>
            ))}
          </ResultSection>

          <ResultSection title="Projects">
            {results.lists.map((l) => {
              const chip = l.projectStatus ? STATUS_CHIP[l.projectStatus] : null;
              return (
                <StaggerItem key={l.listId}>
                  <Link
                    href={`/dashboard/l/${l.listId}`}
                    className="lift flex items-center justify-between gap-3 rounded-2xl panel px-4 py-3"
                  >
                    <span className="min-w-0 truncate text-sm font-medium">{l.name}</span>
                    <span className="flex flex-shrink-0 items-center gap-2">
                      {chip && (
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[10px] font-medium text-foreground",
                            chip.className,
                          )}
                        >
                          {chip.label}
                        </span>
                      )}
                      <span className="truncate text-xs text-muted-foreground">
                        {l.spaceName}
                      </span>
                    </span>
                  </Link>
                </StaggerItem>
              );
            })}
          </ResultSection>

          <ResultSection title="Docs">
            {results.docs.map((d) => (
              <StaggerItem key={d.docId}>
                <Link
                  href={`/dashboard/d/${d.docId}`}
                  className="lift flex items-center justify-between gap-3 rounded-2xl panel px-4 py-3"
                >
                  <span className="min-w-0 truncate text-sm font-medium">{d.title}</span>
                  <span className="flex-shrink-0 truncate text-xs text-muted-foreground">
                    {d.spaceName}
                  </span>
                </Link>
              </StaggerItem>
            ))}
          </ResultSection>

          <ResultSection title="Spaces">
            {results.spaces.map((s) => (
              <StaggerItem key={s.spaceId}>
                <Link
                  href={`/dashboard/s/${s.spaceId}`}
                  className="lift flex items-center gap-2 rounded-2xl panel px-4 py-3"
                >
                  {s.private && (
                    <Lock className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <span className="min-w-0 truncate text-sm font-medium">{s.name}</span>
                </Link>
              </StaggerItem>
            ))}
          </ResultSection>
        </div>
      )}
    </div>
  );
}

function ResultSection({ title, children }: { title: string; children: React.ReactNode }) {
  const items = children as React.ReactNode[];
  const count = Array.isArray(items) ? items.length : 0;
  if (count === 0) return null;
  return (
    <section className="space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <Stagger className="space-y-2">{children}</Stagger>
    </section>
  );
}

function SearchSkeleton() {
  return (
    <div className="space-y-8">
      {[0, 1, 2].map((s) => (
        <div key={s} className="space-y-2">
          <div className="h-3 w-16 animate-pulse rounded-full bg-muted" />
          {[0, 1].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-2xl bg-muted/50" />
          ))}
        </div>
      ))}
    </div>
  );
}
