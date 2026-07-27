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
          {pages.map((p) => (
            <StaggerItem key={p.pageId}>
              <Link href={`/dashboard/pages/${p.pageId}`} className="lift block">
                <Card className="h-full rounded-2xl p-5">
                  <h2 className="truncate text-sm font-medium">{p.title}</h2>
                  {p.excerpt && (
                    <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                      {p.excerpt}
                    </p>
                  )}
                  <div className="mt-4 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span>
                      {p.updatedByName
                        ? `${p.updatedByName} · ${timeAgo(p.updatedAt)}`
                        : timeAgo(p.updatedAt)}
                    </span>
                    {p.attachmentCount > 0 && (
                      <span className="ml-auto">
                        pinned to {p.attachmentCount}
                      </span>
                    )}
                  </div>
                </Card>
              </Link>
            </StaggerItem>
          ))}
        </Stagger>
      )}
    </div>
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
