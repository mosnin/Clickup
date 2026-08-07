"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { FileText, Plus, Search } from "lucide-react";
import { api } from "@convex/_generated/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/dashboard/page-header";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Stagger, StaggerItem } from "@/components/motion";
import { useToast } from "@/components/toast";
import { errorMessage } from "@/lib/errors";
import { timeAgo } from "@/lib/time";
import { cn } from "@/lib/utils";

// Every page in one place, per scope.
//
// The scope lives in the URL (?scope=user:… / ?scope=workspace:…) so a link
// to "the workspace's pages" is shareable and survives a reload — the same
// rule the list views follow with ?view=.

export function PagesIndex() {
  const router = useRouter();
  const params = useSearchParams();
  const scopes = useQuery(api.pages.scopesForCurrentUser, {});
  const [search, setSearch] = useState("");
  const { toast } = useToast();
  const createPage = useMutation(api.pages.create);

  const active = useMemo(() => {
    const raw = params.get("scope");
    if (raw) {
      const [scopeType, ...rest] = raw.split(":");
      if (scopeType === "user" || scopeType === "workspace") {
        return { scopeType, scopeId: rest.join(":") } as const;
      }
    }
    const first = scopes?.[0];
    return first
      ? ({ scopeType: first.scopeType, scopeId: first.scopeId } as const)
      : null;
  }, [params, scopes]);

  const pages = useQuery(
    api.pages.listForScope,
    active
      ? {
          scopeType: active.scopeType,
          scopeId: active.scopeId,
          search: search.trim() || undefined,
        }
      : "skip",
  );

  // Pages nest. The index shows roots with their subpages underneath —
  // except while searching, where hiding a match under a parent that didn't
  // match is exactly the wrong answer.
  const searching = search.trim().length > 0;
  const childrenOf = useMemo(() => {
    const map = new Map<string, typeof pages>();
    if (!pages || searching) return map;
    for (const p of pages) {
      if (!p.parentPageId) continue;
      const bucket = map.get(p.parentPageId) ?? [];
      bucket.push(p);
      map.set(p.parentPageId, bucket);
    }
    return map;
  }, [pages, searching]);

  const roots = useMemo(() => {
    if (!pages) return [];
    if (searching) return pages;
    const ids = new Set(pages.map((p) => p.pageId));
    // A page whose parent is outside this scope (or archived) would
    // otherwise vanish from the index entirely.
    return pages.filter((p) => !p.parentPageId || !ids.has(p.parentPageId));
  }, [pages, searching]);

  async function newPage() {
    if (!active) return;
    try {
      const pageId = await createPage({
        scopeType: active.scopeType,
        scopeId: active.scopeId,
        title: "Untitled",
        markdown: "",
      });
      router.push(`/dashboard/pages/${pageId}`);
    } catch (e) {
      toast(errorMessage(e, "Couldn't create the page"), { kind: "error" });
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Everything written down"
        description="Investigations, decisions and runbooks — the things that outlive a comment, written by people and agents alike."
        icon={FileText}
        title="Pages"
        context={
          pages === undefined
            ? undefined
            : `${pages.length} page${pages.length === 1 ? "" : "s"}`
        }
        actions={
          <Button size="sm" onClick={() => void newPage()} disabled={!active}>
            <Plus className="h-3.5 w-3.5" />
            New page
          </Button>
        }
      />


      <div className="flex flex-wrap items-center gap-3">
        {(scopes ?? []).length > 1 && (
          <div className="segmented">
            {(scopes ?? []).map((s) => {
              const on =
                active?.scopeType === s.scopeType &&
                active?.scopeId === s.scopeId;
              return (
                <button
                  key={`${s.scopeType}:${s.scopeId}`}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    router.replace(
                      `/dashboard/pages?scope=${s.scopeType}:${s.scopeId}`,
                    )
                  }
                  className={cn("px-3 py-1.5 text-xs", on && "segmented-on")}
                >
                  {s.name}
                </button>
              );
            })}
          </div>
        )}
        <label className="soft-field flex min-w-0 flex-1 items-center gap-2 px-3 py-2 sm:max-w-sm">
          <Search className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            placeholder="Search pages…"
            aria-label="Search pages"
            className="min-w-0 flex-1 bg-transparent text-sm focus:outline-none"
          />
        </label>
      </div>

      {pages === undefined ? (
        <IndexSkeleton />
      ) : pages.length === 0 ? (
        <EmptyState
          title={search ? "No pages match" : "No pages yet"}
          message={
            search
              ? "Try a different word — search covers titles and body text."
              : "A page is where the reasoning lives: the brief, the spec, the decision record. Agents write them in markdown; you read and edit the same text."
          }
          action={
            search ? undefined : (
              <Button variant="outline" size="sm" onClick={() => void newPage()}>
                Write the first one
              </Button>
            )
          }
        />
      ) : (
        <Stagger className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {roots.map((p) => (
            <StaggerItem key={p.pageId}>
              <PageCard page={p} childrenOf={childrenOf} />
            </StaggerItem>
          ))}
        </Stagger>
      )}
    </div>
  );
}

type PageRow = {
  pageId: string;
  title: string;
  excerpt: string;
  parentPageId?: string;
  updatedAt: number;
  updatedByName?: string;
  attachmentCount: number;
};

function PageCard({
  page,
  childrenOf,
}: {
  page: PageRow;
  childrenOf: Map<string, PageRow[] | undefined>;
}) {
  const kids = childrenOf.get(page.pageId) ?? [];
  return (
    <Card className="h-full rounded-2xl p-5">
      <Link href={`/dashboard/pages/${page.pageId}`} className="block">
        <h2 className="truncate text-sm font-medium hover:underline">
          {page.title}
        </h2>
        {page.excerpt && (
          <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
            {page.excerpt}
          </p>
        )}
      </Link>
      {kids.length > 0 && (
        <ul className="mt-3 space-y-1 border-l border-border pl-3">
          {kids.slice(0, 4).map((k) => (
            <li key={k.pageId}>
              <Link
                href={`/dashboard/pages/${k.pageId}`}
                className="block truncate text-xs text-muted-foreground hover:text-foreground hover:underline"
              >
                {k.title}
              </Link>
            </li>
          ))}
          {kids.length > 4 && (
            <li className="text-xs text-muted-foreground">
              +{kids.length - 4} more
            </li>
          )}
        </ul>
      )}
      <div className="mt-4 flex items-center gap-2 text-tiny text-muted-foreground">
        <span>
          {page.updatedByName
            ? `${page.updatedByName} · ${timeAgo(page.updatedAt)}`
            : timeAgo(page.updatedAt)}
        </span>
        {page.attachmentCount > 0 && (
          <span className="ml-auto">pinned to {page.attachmentCount}</span>
        )}
      </div>
    </Card>
  );
}

function IndexSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="h-36 animate-pulse rounded-2xl bg-muted" />
      ))}
    </div>
  );
}
