"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { Lock, Search } from "lucide-react";
import { api } from "@convex/_generated/api";
import { Stagger, StaggerItem } from "@/components/motion";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/dashboard/page-header";
import { EmptyState } from "@/components/dashboard/empty-state";
import { NameLink, StatusDot, TotalCount } from "@/components/dashboard/deel-ui";

// Global search: one text box, four buckets (tasks/projects/docs/spaces),
// all access-checked server-side by convex/search.ts. The query text lives
// in ?q= so a search is shareable, but typing itself is debounced 250ms
// before it ever reaches Convex or the URL.

type Results = NonNullable<ReturnType<typeof useQuery<typeof api.search.everything>>>;

const STATUS_DOT: Record<
  NonNullable<Results["lists"][number]["projectStatus"]>,
  { label: string; color: string }
> = {
  on_track: { label: "On track", color: "var(--color-success, #16a34a)" },
  at_risk: { label: "At risk", color: "#d97706" },
  off_track: { label: "Off track", color: "var(--color-danger)" },
  paused: { label: "Paused", color: "var(--color-muted-foreground)" },
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
    ? results.tasks.length + results.pages.length + results.lists.length + results.spaces.length
    : 0;

  return (
    <div className="space-y-8">
      <PageHeader
        description={"Tasks, pages, boards and people across every space you can reach."}
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
          <ResultSection title="Tasks" count={results.tasks.length}>
            {results.tasks.map((t) => (
              <StaggerItem key={t.taskId}>
                <div className="deel-kv-row !grid-cols-[minmax(0,1fr)_auto]">
                  <NameLink href={`/dashboard/l/${t.listId}/t/${t.taskId}`}>
                    {t.title}
                  </NameLink>
                  <span className="text-sm text-muted-foreground">{t.listName}</span>
                </div>
              </StaggerItem>
            ))}
          </ResultSection>

          <ResultSection title="Projects" count={results.lists.length}>
            {results.lists.map((l) => {
              const chip = l.projectStatus ? STATUS_DOT[l.projectStatus] : null;
              return (
                <StaggerItem key={l.listId}>
                  <div className="deel-kv-row !grid-cols-[minmax(0,1fr)_auto]">
                    <NameLink href={`/dashboard/l/${l.listId}`}>{l.name}</NameLink>
                    <span className="flex items-center gap-2">
                      {chip && <StatusDot color={chip.color} label={chip.label} />}
                      <span className="text-sm text-muted-foreground">{l.spaceName}</span>
                    </span>
                  </div>
                </StaggerItem>
              );
            })}
          </ResultSection>

          <ResultSection title="Pages" count={results.pages.length}>
            {results.pages.map((d) => (
              <StaggerItem key={d.pageId}>
                <div className="deel-kv-row !grid-cols-[minmax(0,1fr)_auto]">
                  <NameLink href={`/dashboard/pages/${d.pageId}`}>{d.title}</NameLink>
                  <span className="text-sm text-muted-foreground">{d.spaceName}</span>
                </div>
              </StaggerItem>
            ))}
          </ResultSection>

          <ResultSection title="Spaces" count={results.spaces.length}>
            {results.spaces.map((s) => (
              <StaggerItem key={s.spaceId}>
                <div className="deel-kv-row !grid-cols-[minmax(0,1fr)_auto]">
                  <NameLink href={`/dashboard/s/${s.spaceId}`}>
                    {s.private ? (
                      <span className="inline-flex items-center gap-2">
                        <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                        {s.name}
                      </span>
                    ) : (
                      s.name
                    )}
                  </NameLink>
                </div>
              </StaggerItem>
            ))}
          </ResultSection>
        </div>
      )}
    </div>
  );
}

function ResultSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <TotalCount count={count} singular="result" />
      </div>
      <div className="deel-kv-card">
        <Stagger>{children}</Stagger>
      </div>
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
