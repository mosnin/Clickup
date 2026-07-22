"use client";

import Link from "next/link";
import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { Brain as BrainIcon, Sparkles } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription } from "@/components/ui/card";
import { PageHeader } from "@/components/dashboard/page-header";
import { Stagger, StaggerItem } from "@/components/motion";

type Scope = { type: "user"; id: string } | { type: "workspace"; id: string };

type Source = {
  parentType: "doc" | "task";
  parentId: string;
  textPreview: string;
};

const EXAMPLE_PROMPTS = [
  "What's blocking the launch?",
  "Summarize the open work in this space",
  "Who owns the design review?",
  "What did we decide about pricing?",
];

export function Brain() {
  const tree = useQuery(api.sidebar.tree, {});
  const brainSearch = useAction(api.ai.brainSearch);

  const [scopeKey, setScopeKey] = useState<string>("personal");
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState<string | null>(null);

  if (tree === undefined) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-1/3 animate-pulse rounded-full bg-muted" />
        <div className="h-12 w-full animate-pulse rounded-full bg-muted" />
        <Card className="h-32 animate-pulse bg-muted/40" />
      </div>
    );
  }
  if (tree === null) return null;

  const scopeOptions: { key: string; label: string; scope: Scope }[] = [
    {
      key: "personal",
      label: "Personal",
      scope: { type: "user", id: tree.currentClerkId },
    },
    ...tree.workspaces.map((w) => ({
      key: `ws:${w._id}`,
      label: w.name,
      scope: { type: "workspace" as const, id: w._id as string },
    })),
  ];
  const activeScope =
    scopeOptions.find((s) => s.key === scopeKey)?.scope ??
    scopeOptions[0]?.scope;

  async function run(q: string) {
    if (!q.trim() || pending || !activeScope) return;
    setQuery(q);
    setPending(true);
    setError(null);
    setAnswer(null);
    setSources([]);
    try {
      const res = await brainSearch({
        scopeType: activeScope.type,
        scopeId: activeScope.id,
        query: q.trim(),
      });
      setAnswer(res.answer);
      setSources(res.sources);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to search");
    } finally {
      setPending(false);
    }
  }

  const idle = !pending && !answer && !error && sources.length === 0;

  return (
    <div className="space-y-6">
      <PageHeader icon={BrainIcon} title="Brain">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(query);
          }}
          className="flex flex-col gap-2 pb-3 sm:flex-row sm:items-center"
        >
          <label className="flex flex-shrink-0 items-center gap-2 text-xs text-muted-foreground">
            Search in
            <select
              value={scopeKey}
              onChange={(e) => setScopeKey(e.currentTarget.value)}
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {scopeOptions.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <Input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="What's blocking the launch? Who owns the design review?"
            className="flex-1"
          />
          <Button type="submit" disabled={!query.trim() || pending}>
            <Sparkles className="h-4 w-4" />
            {pending ? "Thinking…" : "Ask"}
          </Button>
        </form>
      </PageHeader>

      {/* Empty state: guided example prompts, so the page is never a blank
          search box staring back at you. */}
      {idle && (
        <Card className="p-6">
          <CardDescription className="text-xs font-semibold uppercase tracking-wider">
            Try asking
          </CardDescription>
          <div className="mt-3 flex flex-wrap gap-2">
            {EXAMPLE_PROMPTS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => run(p)}
                className="rounded-full border border-border bg-background px-3.5 py-1.5 text-sm text-foreground/80 transition-colors hover:border-foreground/25 hover:text-foreground"
              >
                {p}
              </button>
            ))}
          </div>
        </Card>
      )}

      {pending && (
        <Card className="space-y-2 p-5">
          <div className="h-3 w-4/5 animate-pulse rounded-full bg-muted" />
          <div className="h-3 w-full animate-pulse rounded-full bg-muted" />
          <div className="h-3 w-2/3 animate-pulse rounded-full bg-muted" />
        </Card>
      )}

      {error && (
        <Card className="border-destructive/30 bg-destructive/5 p-4">
          <CardContent className="p-0 text-sm text-destructive">
            {error}
          </CardContent>
        </Card>
      )}

      {answer && (
        <Card className="p-5">
          <CardContent className="whitespace-pre-wrap p-0 text-sm leading-relaxed">
            {answer}
          </CardContent>
        </Card>
      )}

      {sources.length > 0 && (
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Sources
          </h2>
          <Stagger className="mt-2 space-y-2">
            {sources.map((s, i) => (
              <StaggerItem key={`${s.parentType}:${s.parentId}`}>
                <SourceLink index={i + 1} source={s} />
              </StaggerItem>
            ))}
          </Stagger>
        </section>
      )}
    </div>
  );
}

function SourceLink({ index, source }: { index: number; source: Source }) {
  // Docs link straight to the editor; tasks resolve their listId first.
  const taskListId = useQuery(
    api.tasks.resolveListId,
    source.parentType === "task"
      ? { taskId: source.parentId as Id<"tasks"> }
      : "skip",
  );
  const href =
    source.parentType === "doc"
      ? `/dashboard/d/${source.parentId}`
      : taskListId
        ? `/dashboard/l/${taskListId}/t/${source.parentId}`
        : null;

  const inner = (
    <Card className="lift flex-row items-start gap-3 px-4 py-3 hover:border-foreground/25">
      <span className="mt-0.5 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-medium text-brand-700">
        {index}
      </span>
      <CardContent className="min-w-0 flex-1 p-0">
        <CardDescription className="text-xs font-semibold uppercase tracking-wider">
          {source.parentType}
        </CardDescription>
        <p className="mt-0.5 truncate text-sm text-foreground">
          {source.textPreview}
        </p>
      </CardContent>
    </Card>
  );

  return href ? <Link href={href}>{inner}</Link> : inner;
}
